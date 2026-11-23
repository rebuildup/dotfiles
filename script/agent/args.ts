#!/usr/bin/env bun
/**
 * argv parsing for the agent-form CLI: the forbidden-passthru flag tables
 * (generic + OMP-adapter-scoped), passthru validation, task subcommand
 * parsing, and the Action union consumed by the dispatcher. Extracted from
 * script/agent.ts; Harness is imported type-only (no runtime cycle).
 */

import { AgentError } from "./errors.ts";
import type { Harness } from "./config.ts";

// ---------------------------------------------------------------------------
// argv parsing (agent-form)
// ---------------------------------------------------------------------------

const FORBIDDEN_PASSTHRU: Record<string, string> = {
  "--model": "use the launcher's model option instead (--model for `agent …`, --agent-model for shortcuts)",
  "-m": "use the launcher's model option instead (--model for `agent …`, --agent-model for shortcuts)",
  "--provider": "the provider is chosen as: agent <harness> <provider>",
  "--api-key": "credentials come from Infisical via script/with-secrets",
  "--fallback-model": "automatic model fallback is intentionally unsupported",
};

// OMP reads its credential/config ladder from files and env that the launcher
// verifies before starting. These flags would move that source after the check
// (or re-point the model roles), so they are rejected for the omp adapter.
// The same flag spellings are harmless or meaningful to other harnesses, so
// the list is adapter-scoped.
const OMP_FORBIDDEN_PASSTHRU: Record<string, string> = {
  "--profile": "profiles relocate OMP's auth/config dir; the launcher verifies only the default profile",
  "--config": "an extra config overlay is outside the launcher's credential-source check and would re-place the launcher's tool-surface overlay arrays",
  "--cwd": "changing cwd changes the project .omp config and .env that OMP reads",
  "--smol": "the launcher pins this model role to the route model",
  "--slow": "the launcher pins this model role to the route model",
  "--plan": "the launcher pins this model role to the route model",
  "--prewalk": "prewalk switches to another model automatically; implicit switching is unsupported",
  "--prewalk-into": "prewalk switches to another model automatically; implicit switching is unsupported",
  "--plan-yolo": "plan-yolo changes the model and auto-approves the plan; the launcher does not imply either",
  "--plan-yolo-into": "plan-yolo changes the model and auto-approves the plan; the launcher does not imply either",
  "--trusted-extension": "the launcher names every trusted module; an extra module can register a credential/model fallback outside the guard",
  "--extension": "an extra extension can register a credential/model fallback outside the guard and change routing mid-session",
  "-e": "an extra extension can register a credential/model fallback outside the guard and change routing mid-session",
  "--hook": "an extra hook/extension can register a credential/model fallback outside the guard and change routing mid-session",
  "--advisor": "the launcher rejects advisor.enabled: true in config; the CLI flag must not enable the advisor runtime anyway",
  "--tools": "the Worker tool surface is fixed at read,bash,edit,write; a later --tools replaces the launcher's list (last-wins)",
  "--models": "the launcher validates the route model; --models feeds unvalidated ids to Ctrl+P cycling",
};

export function checkPassthru(passthru: string[], harness: Harness): void {
  const forbidden =
    harness.adapter === "omp"
      ? { ...FORBIDDEN_PASSTHRU, ...OMP_FORBIDDEN_PASSTHRU }
      : FORBIDDEN_PASSTHRU;
  for (const token of passthru) {
    // Match `--flag` and `--flag=value` forms alike so an inline value
    // cannot smuggle a forbidden selector past this filter.
    const flag = token.startsWith("-") ? token.split("=", 1)[0] : token;
    const reason = forbidden[flag];
    if (reason) {
      throw new AgentError(
        `harness argument '${token}' is not allowed for adapter '${harness.adapter}': ${reason}`
      );
    }
  }
}

function parseTaskArgs(argv: string[]): Action {
  const sub = argv[0];
  if (sub === "status") {
    if (argv.length !== 2) {
      throw new AgentError("usage: agent task status <task-id>");
    }
    return ["task", "status", argv[1]];
  }
  if (sub === "reconcile") {
    const taskId = argv[1];
    if (!taskId || taskId.startsWith("-")) {
      throw new AgentError("usage: agent task reconcile <task-id>");
    }
    return ["task", "reconcile", taskId];
  }
  if (sub === "resume") {
    const taskId = argv[1];
    if (!taskId || taskId.startsWith("-")) {
      throw new AgentError(
        "usage: agent task resume <task-id> [--prompt <text>] [--timeout <ms>]"
      );
    }
    const opts: TaskResumeOptions = { prompt: null, timeoutMs: null };
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      const take = (): string => {
        const value = rest[++i];
        if (value === undefined) throw new AgentError(`${token} requires a value`);
        return value;
      };
      if (token === "--prompt") opts.prompt = take();
      else if (token === "--timeout") {
        const ms = Number(take());
        if (!Number.isFinite(ms) || ms <= 0) {
          throw new AgentError("--timeout must be a positive number of milliseconds");
        }
        opts.timeoutMs = ms;
      } else {
        throw new AgentError(`unexpected argument '${token}' for task resume`);
      }
    }
    return ["task", "resume", taskId, opts];
  }
  if (sub !== "run") {
    throw new AgentError(
      `unknown task action '${sub ?? ""}'; usage: agent task run|resume|status|reconcile ...`
    );
  }
  const route = argv[1];
  if (!route || route.startsWith("-")) {
    throw new AgentError(
      "usage: agent task run <harness.provider> [--model <id>] [--fallback <profile-id>] " +
        "[--runtime herdr|rex] [--rex-host <label>] [--cwd <path>] " +
        "[--prompt <text>] [--accept <criteria>]..."
    );
  }
  const opts: TaskRunOptions = {
    model: null, fallback: null, prompt: null, accept: [], timeoutMs: null,
    allowUnobservedEffects: false, runtime: null, rexHost: null, cwd: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const take = (): string => {
      const value = rest[++i];
      if (value === undefined) throw new AgentError(`${token} requires a value`);
      return value;
    };
    if (token === "--model" || token === "-m") opts.model = take();
    else if (token === "--fallback") opts.fallback = take();
    else if (token === "--prompt") opts.prompt = take();
    else if (token === "--accept") opts.accept.push(take());
    else if (token === "--runtime") {
      const value = take();
      if (value !== "herdr" && value !== "rex") {
        throw new AgentError(`--runtime must be 'herdr' or 'rex', got '${value}'`);
      }
      opts.runtime = value;
    }
    else if (token === "--rex-host") opts.rexHost = take();
    else if (token === "--cwd") opts.cwd = take();
    else if (token === "--allow-unobserved-effects") opts.allowUnobservedEffects = true;
    else if (token === "--timeout") {
      const raw = take();
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new AgentError(`--timeout must be a positive number of milliseconds`);
      }
      opts.timeoutMs = ms;
    } else {
      throw new AgentError(
        `unexpected argument '${token}'; usage: agent task run <route> ` +
          "[--model <id>] [--fallback <profile-id>] [--runtime herdr|rex] " +
          "[--rex-host <label>] [--cwd <path>] [--prompt <text>] " +
          "[--accept <criteria>]... [--timeout <ms>]"
      );
    }
  }
  return ["task", "run", route, opts];
}

export interface TaskRunOptions {
  model: string | null;
  fallback: string | null;
  prompt: string | null;
  accept: string[];
  timeoutMs: number | null;
  allowUnobservedEffects: boolean;
  /** Explicit execution runtime (ADR-0021); null = herdr (default). */
  runtime: "herdr" | "rex" | null;
  /** Rex host label/address (dotfiles#209); requires --runtime rex. */
  rexHost: string | null;
  /** Worker working directory; remote hosts require an absolute remote path. */
  cwd: string | null;
}

export interface TaskResumeOptions {
  prompt: string | null;
  timeoutMs: number | null;
}

export type TaskAction =
  | ["task", "run", string, TaskRunOptions]
  | ["task", "status", string]
  | ["task", "resume", string, TaskResumeOptions]
  | ["task", "reconcile", string];

export type Action =
  | ["help", boolean]
  | ["version"]
  | ["list"]
  | ["check"]
  | ["models", string]
  | ["shortcuts", string | null]
  | ["native", string, string[]]
  | ["run", string, string, string | null, string[]]
  | ["fallback", string, boolean]  // profile-id, json
  | ["review", string[]]           // `agent review ...` tokens after the verb
  | TaskAction
export function parseArgs(argv: string[]): Action {
  // Parse argv without touching the config.
  const head = argv[0];
  if (head === "help" || head === "--help" || head === "-h") {
    // Only the explicit subcommand spelling takes --json; `--help` after a
    // route keeps printing the plain usage (the harness gets its own help
    // via `-- --help`).
    if (head === "help" && argv.length === 2 && argv[1] === "--json") {
      return ["help", true];
    }
    if (argv.length > 1) {
      throw new AgentError(`unexpected arguments for 'help': ${argv.slice(1).join(" ")}`);
    }
    return ["help", false];
  }
  if (head === "--version" || head === "-V") {
    return ["version"];
  }
  if (head === "list") {
    if (argv.length > 1) {
      throw new AgentError(`unexpected arguments for 'list': ${argv.slice(1).join(" ")}`);
    }
    return ["list"];
  }
  if (head === "check") {
    if (argv.length > 1) {
      throw new AgentError(`unexpected arguments for 'check': ${argv.slice(1).join(" ")}`);
    }
    return ["check"];
  }
  if (head === "models") {
    if (argv.length !== 2) {
      throw new AgentError("usage: agent models <provider>");
    }
    return ["models", argv[1]];
  }
  if (head === "shortcuts") {
    if (argv.length < 2) {
      return ["shortcuts", null];
    }
    if (argv.length === 2 && ["list", "check", "create", "remove"].includes(argv[1])) {
      return ["shortcuts", argv[1]];
    }
    throw new AgentError(
      `unknown shortcuts action '${argv.slice(1).join(" ")}'; ` +
        "usage: agent shortcuts [list|check|create|remove]"
    );
  }
  if (head === "task") {
    return parseTaskArgs(argv.slice(1));
  }
  if (head === "review") {
    // `agent review run|run-file ...` — parsed by cmdReview; kept out of the
    // harness/provider grammar so 'review' is never mistaken for a harness.
    return ["review", argv.slice(1)];
  }
  if (head === "fallback") {
    if (argv.length < 2) {
      throw new AgentError("usage: agent fallback <profile-id> [--json]");
    }
    const profileId = argv[1];
    let json = false;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--json") {
        json = true;
      } else {
        throw new AgentError(`unexpected argument '${argv[i]}'; usage: agent fallback <profile-id> [--json]`);
      }
    }
    return ["fallback", profileId, json];
  }


   const harnessKey = head;
  if (argv.length < 2) {
    // Provider omitted: native mode — run the harness untouched (no
    // endpoint/model/credential injection; its own subscription/account).
    return ["native", harnessKey, []];
  }
  if (argv[1] === "--help" || argv[1] === "-h" || argv[1] === "help") {
    return ["help", false];
  }
  if (argv[1] === "--model" || argv[1] === "-m") {
    throw new AgentError(
      `--model requires a provider route: agent ${harnessKey} <provider> --model <id> ` +
        "(native mode keeps the harness's own model selection)"
    );
  }
  if (argv[1].startsWith("-")) {
    // No provider name starts with '-': everything here belongs to the
    // harness in native mode. Only a '--' as the first harness token is a
    // separator; any later '--' is forwarded with the rest of the tail.
    const passthru = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
    return ["native", harnessKey, passthru];
  }
  const providerKey = argv[1];

  let model: string | null = null;
  let passthru: string[] = [];
  const rest = argv.slice(2);
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === "--") {
      passthru = rest.slice(index + 1);
      break;
    }
    if (token === "--model" || token === "-m") {
      if (index + 1 >= rest.length) {
        throw new AgentError(`${token} requires a value`);
      }
      model = rest[index + 1];
      index += 2;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return ["help", false];
    }
    throw new AgentError(
      `unexpected argument '${token}'; pass harness arguments after '--' ` +
        `(e.g. agent ${harnessKey} ${providerKey} -- <args>)`
    );
  }
  return ["run", harnessKey, providerKey, model, passthru];
}

