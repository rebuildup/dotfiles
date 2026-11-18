#!/usr/bin/env bun
/**
 * agent — unified launcher for AI coding harnesses (Bun + TypeScript).
 *
 * Reads the declarative config (config/agents.toml) and starts exactly one
 * harness with exactly one provider:
 *
 *     agent <harness> <provider> [--model <id>] [-- <harness args>...]
 *     <harness>-<provider> [<harness args>...]      # shortcut form
 *     agent list | models <provider> | shortcuts [list|check|create|remove]
 *         | check | help
 *
 * Design contract:
 *   * Thin: parse TOML (Bun.TOML) -> build environment -> spawn the native
 *     CLI with inherited stdio (interactive TUIs keep working; on Unix the
 *     harness used to be exec'd — a single child process per launch is now
 *     used uniformly because Bun has no execve).
 *   * No hardcoded model ids, endpoints or credential env names; they all
 *     come from config/agents.toml (this file only contains adapters, i.e.
 *     how a harness selects a provider/model with its verified native CLI).
 *   * Model resolution: --model / --agent-model > route default > provider
 *     default > harness-native default (only for passthrough harnesses).
 *     Anything else fails before a process starts.
 *   * Credentials come from script/with-secrets (Infisical) process-scoped;
 *     on Windows the PowerShell mirror script/with-secrets.ps1 is used.
 *     The environment is filtered so other providers' secrets never reach
 *     the harness process, and no secret value is ever placed in argv.
 *   * No implicit provider switching, no silent model fallback, no quota
 *     failover. Plain `claude` remains native and untouched.
 *
 * Shortcuts are exact route names (`opencode-zen` = `agent opencode zen`)
 * resolved against config/agents.toml. They are provided as symlinks to
 * this script (Unix) or generated .cmd entry points (Windows); the invoked
 * name is recovered from the kernel-level argv because Bun resolves
 * symlinked argv[1]. Native `claude`/`opencode`/`omp`/`dsh` are never
 * wrapped or overridden.
 */

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import {
  buildGuideData,
  buildHelpData,
  buildRoutesData,
  renderGuideText,
  renderRoutesText,
  UnknownGuideTopicError,
} from "./agent/help";
import { getPrimaryQuotaScope, loadCatalog, type Catalog } from "./agent/catalog";
import {
  buildFallbackCatalog,
  listFallbackProfiles,
  loadCatalogAttestations,
  mergeAttestations,
  parseFallbackProfile,
  resolveFallbackProfile,
  renderFallbackResolution,
  seedAttestationsFromCatalog,
} from "./agent/fallback";
import { ContractError, isPlainObject, parseTomlTable, redactJson, splitRouteKey } from "./agent/contract";
import { AgentError, EXIT_RUNTIME, EXIT_USAGE } from "./agent/errors";
import { guardOmpCredentialSource, guardOmpImplicitSwitch, planOmp } from "./agent/omp";
import { dotfilesRepoRoot, IS_WINDOWS, which } from "./agent/util";
import {
  cmdShortcuts,
  invokedScriptPath,
  parseShortcutArgs,
  resolveShortcut,
  shortcutMap,
  shortcutName,
} from "./agent/shortcuts";
import {
  configPath,
  effectiveModels,
  loadConfig,
  routeDefaultModel,
  type Config,
  type Harness,
  type OcModelSpec,
  type Provider,
  type Route,
} from "./agent/config";

const PROGRAM = "agent";

// argv-safe assign marker handled inside the child stage: only the model id
// crosses argv, the surrounding config is merged from the environment.
const MODEL_MARKER = "@@model:";
// argv-safe marker for the OpenCode custom-provider block: the payload is a
// JSON object mapping the provider id to its block (npm package, endpoint
// URL, credential env NAME, model specs). It never contains a credential
// value — OpenCode reads the key from the named env var — so it is safe to
// carry in argv like every other plan token.
const PROVIDER_MARKER = "@@provider:";
// argv-safe marker for "copy this secret from another env name"; kept
// distinct from a bare `@` so real model ids that start with `@`
// (e.g. Cloudflare's `@cf/...`) pass through as literal values.
const CRED_MARKER = "@@cred:";

const LAUNCHER_BASENAME = basename(import.meta.path);

const USAGE = `\
usage:
  agent <harness> <provider> [--model <id>] [-- <harness args>...]
  agent <harness> [-- <harness args>...]        # native: no provider, no injection
  <harness>-<provider> [<harness args>...]      # shortcut (agent shortcuts create)
  agent list
  agent models <provider>
  agent shortcuts [list|check|create|remove]
  agent check
  agent guide [topic]
  agent routes [--json]
  agent fallback <profile-id> [--json]
  agent task run <route> --model <id> [--fallback <profile-id>]
      [--prompt <text>] [--accept <criteria>]...
  agent task status <task-id>
  agent help
subcommands:
  agent help                 show this help
  agent list                 show every configured harness/provider route
                             (with its shortcut name)
  agent models <provider>    show a provider's credential names and models
  agent shortcuts            list the shortcut names derived from the routes
                             and whether each link is in place
  agent shortcuts check      exit non-zero unless every shortcut link is ours
  agent shortcuts create     create ~/.local/bin/<harness>-<provider> entry
                             points (Unix: symlinks to this launcher;
                             Windows: generated .cmd files). Idempotent;
                             never overwrites a file or command it does not own
  agent shortcuts remove     remove only the entries that point at this
                             launcher; other files are left untouched
  agent check                validate config/agents.toml (used by CI)
  agent guide [topic]        progressive disclosure: routes, status, limits,
                             distributed, recovery, quality, misfire
  agent routes               route table with catalog facts (quota scopes,
                             rate limits, restrictions, e2e evidence);
                             --json emits the same data as redacted JSON
  agent fallback <profile-id> [--json]  resolve and display an opt-in
                             continuity profile for authorized same-harness
                             fallback (issue #136); does not execute fallback
  agent task run <route>               dispatch a prompt to a Herdr worker on
                             <harness>.<provider>; --model selects the model
                             (route default when omitted), --fallback names an
                             opt-in continuity profile whose candidates may
                             serve the task after a classified primary
                             failure, --prompt supplies the task text (stdin
                             when omitted and stdin is not a TTY), --accept
                             records an acceptance criterion (repeatable)
  agent task status <task-id>          show the durable state of a dispatched
                             task (attempts, generations, classified failures)
  agent help --json          machine-readable help (quotes this text)

shortcut form:
  Invoking <harness>-<provider> (e.g. opencode-zen) is resolved by exact
  match against the routes in config/agents.toml — never by splitting on
  hyphens — and behaves exactly like \`agent <harness> <provider>\`.
  \`agent <harness>-<provider>\` is the portable spelling of the same route.
  Arguments go to the harness directly (no '--' needed; a leading '--' is
  tolerated). The launcher-owned model option is:
    --agent-model <id>        equals the route's --model <id> (this process
                              only; never persisted)

native mode (provider omitted):
  \`agent <harness>\` runs the harness natively: the environment is passed
  through untouched — no endpoint, no model and no credential injection
  (Claude Code uses its subscription login, opencode/omp their own account).
  A leading flag or '--' passes harness arguments:
    agent claude -p "say ok"
    agent opencode -- run "explain this repo"
  --model / -m still require a provider route (exit 2); use plain
  \`<harness>\` when you want the harness's own model flags. A failing
  route never falls back to native mode.

run options:
  --model <id>, -m <id>      model for this process only (never persisted)
  --                         everything after it goes to the harness verbatim
  --help, -h                 show this help (after a route: harness -- --help
                             is the way to ask the harness itself)

model resolution for a run:
  --model  >  route default  >  provider default  >  harness-native default
  (harness-native applies only to passthrough harnesses such as dsh)

examples:
  agent opencode zen
  agent opencode zen -- run "explain this repo"
  agent opencode logfare -- run "say ok" # Logfare (explicit route; 5k req/day)
  agent claude deepseek -- -p "say ok"
  agent claude opencode-go -- -p "say ok"   # Go plan, default DeepSeek V4.1 Flash
  agent omp opencode-go -- -p "hello"       # Go plan, default MiMo V2.6 Flash
  agent claude minimax -- -p "say ok"   # default MiniMax-M3.1-Flash (--model overrides)
  agent omp openrouter -- -p "hello"
  agent dsh deepseek -- web
  agent claude -p "say ok"              # native: subscription login, no injection
  agent dsh -- web                      # native dsh (args after '--')
  opencode-zen -- run "explain this repo"   # shortcut form
  claude                       # plain claude keeps official native auth

config: {config_path}
credentials: {with_secrets} (Infisical, process-scoped)
`;

export interface Plan {
  command: string[];
  keep: Set<string>;
  copy: Array<[string, string]>;
  unset: string[];
  assign: Array<[string, string]>;
  // (env_name, secret_name) that must hold a credential before exec
  require_cred: Array<[string, string]>;
  // always inject this route's credential from Infisical (no ambient fast path)
  require_infisical: boolean;
  // OMP credential/endpoint override guard, re-checked immediately before spawn
  omp_guard: {
    providerId: string;
    envName: string;
    // omp_custom routes: the launcher-owned profile agent dir, its managed
    // models.yml path, and the sha256 the file must still match.
    agentDir: string | null;
    modelsPath: string | null;
    modelsSha256: string | null;
  } | null;
  drop: string[];
  baseline: string[] | null; // null = current process env
}


function withSecretsPath(): string {
  return (
    process.env.AGENT_WITH_SECRETS ||
    join(dotfilesRepoRoot(), "script", IS_WINDOWS ? "with-secrets.ps1" : "with-secrets")
  );
}

/** Real path of this launcher; shortcut links must point here, never at a
 * module inside script/agent/ (import.meta.path differs per file). */
function launcherLinkTarget(): string {
  return realpathSync(import.meta.path);
}

function resolveModel(route: Route, provider: Provider, cliModel: string | null): string {
  let model: string | null;
  if (cliModel) {
    model = cliModel;
  } else {
    if (process.env.AGENT_MODEL) {
      console.error("agent: warning: AGENT_MODEL is no longer read; use --model");
    }
    model = routeDefaultModel(route, provider);
    if (model === null) {
      throw new AgentError(
        `route '${route.key}' requires an explicit model; pass --model <id>. ` +
          `Known models: ${effectiveModels(route, provider).join(", ")}`
      );
    }
  }
  const models = effectiveModels(route, provider);
  if (models.length > 0 && !models.includes(model)) {
    throw new AgentError(
      `unknown model '${model}' for route '${route.key}'; known models:\n  ` +
        models.join("\n  ") +
        "\nModels are declared in config/agents.toml (edit it to add one)."
    );
  }
  return model;
}

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

function checkPassthru(passthru: string[], harness: Harness): void {
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
  if (sub !== "run") {
    throw new AgentError(
      `unknown task action '${sub ?? ""}'; usage: agent task run|status ...`
    );
  }
  const route = argv[1];
  if (!route || route.startsWith("-")) {
    throw new AgentError(
      "usage: agent task run <harness.provider> [--model <id>] [--fallback <profile-id>] " +
        "[--prompt <text>] [--accept <criteria>]..."
    );
  }
  const opts = { model: null as string | null, fallback: null as string | null,
    prompt: null as string | null, accept: [] as string[], timeoutMs: null as number | null };
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
          "[--model <id>] [--fallback <profile-id>] [--prompt <text>] " +
          "[--accept <criteria>]... [--timeout <ms>]"
      );
    }
  }
  return ["task", "run", route, opts];
}

type Action =
  | ["help", boolean]
  | ["version"]
  | ["list"]
  | ["check"]
  | ["models", string]
  | ["shortcuts", string | null]
  | ["native", string, string[]]
  | ["run", string, string, string | null, string[]]
  | ["fallback", string, boolean]  // profile-id, json
  | ["task", "run", string, {
      model: string | null;
      fallback: string | null;
      prompt: string | null;
      accept: string[];
      timeoutMs: number | null;
    }]
  | ["task", "status", string];
function parseArgs(argv: string[]): Action {
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

// ---------------------------------------------------------------------------
// Plan building (adapters = verified native CLI contracts)
// ---------------------------------------------------------------------------

function buildPlan(
  config: Config,
  harness: Harness,
  provider: Provider,
  route: Route,
  model: string | null,
  passthru: string[]
): Plan {
  checkPassthru(passthru, harness);

  const keep = new Set<string>();
  const copy: Array<[string, string]> = [];
  const require_cred: Array<[string, string]> = [];
  if (provider.anonymous) {
    // Credential-free endpoint: nothing to fetch, nothing to require, and no
    // credential env name is added to the keep-set. `require_cred` stays empty,
    // so `needsInjection()` returns false and no Infisical stage runs at all.
    if (provider.secret || provider.env) {
      // defensive; loadConfig rejects this combination
      throw new AgentError(
        `provider '${provider.key}' is anonymous but declares a credential`
      );
    }
  } else if (provider.secret || provider.env) {
    const envName = provider.env || provider.secret;
    const secretName = provider.secret || provider.env;
    if (!envName || !secretName) throw new AgentError(`provider '${provider.key}' declares no credential`);
    keep.add(envName);
    keep.add(secretName);
    require_cred.push([envName, secretName]);
    if (envName !== secretName) {
      // stage 2 copies the secret value into the env name the harness reads
      copy.push([envName, secretName]);
    }
  }

  // Every credential name declared anywhere in the config is dropped by
  // default; the route's own keep-set always wins over it. This keeps a
  // newly added provider's shell value out of unrelated harness processes
  // even on the fast path (no script/with-secrets round trip).
  const providerCreds = new Set<string>();
  for (const p of Object.values(config.providers)) {
    if (p.secret) providerCreds.add(p.secret);
    if (p.env) providerCreds.add(p.env);
  }
  const plan: Plan = {
    command: [harness.command, ...passthru],
    keep,
    copy,
    unset: [],
    assign: [],
    require_cred,
    require_infisical: provider.require_infisical,
    omp_guard: null,
    drop: [...new Set([...config.drop_env, ...providerCreds])].sort(),
    baseline: null,
  };

  if (harness.adapter === "anthropic") {
    planAnthropic(plan, harness, provider, route, model);
  } else if (harness.adapter === "opencode") {
    planOpencode(plan, harness, provider, model);
  } else if (harness.adapter === "omp") {
    planOmp(plan, harness, provider, model);
  } else if (harness.adapter === "passthrough") {
    // Model selection stays native for passthrough harnesses; --model is
    // rejected in cmdRun before we get here.
  } else {
    // guarded by loadConfig
    throw new AgentError(`unknown adapter '${harness.adapter}'`);
  }
  return plan;
}

function planAnthropic(
  plan: Plan,
  harness: Harness,
  provider: Provider,
  route: Route,
  model: string | null
): void {
  if (model === null) {
    // defensive; routes validate their defaults
    throw new AgentError(`route '${route.key}' resolved no model`);
  }
  if (!provider.base_url) {
    throw new AgentError(`provider '${provider.key}' has no base_url for adapter anthropic`);
  }
  if (provider.anonymous) {
    // The Anthropic adapter must send an auth token; a credential-free
    // endpoint would look like "no key" to Claude Code, which then falls back
    // to its own login and silently leaves the route. Fail closed instead.
    throw new AgentError(
      `provider '${provider.key}' is anonymous; the anthropic adapter needs a credential, ` +
        "so declare no claude route for it (use the opencode adapter)"
    );
  }
  if (!provider.env) {
    throw new AgentError(`provider '${provider.key}' declares no credential env name`);
  }
  const env = harness.env;
  plan.unset.push(env["api_key"]);
  plan.assign.push(
    [env["base_url"], provider.base_url],
    [env["auth_token"], CRED_MARKER + provider.env],
    [env["model"], model],
    [env["small_fast_model"], model],
    // Single-model routes map every model role (including subagents, which
    // follow ANTHROPIC_DEFAULT_HAIKU_MODEL) to the route model;
    // CLAUDE_CODE_SUBAGENT_MODEL stays unset because it is not needed.
    [env["default_opus"], model],
    [env["default_sonnet"], model],
    [env["default_haiku"], model]
  );
}

function planOpencode(plan: Plan, harness: Harness, provider: Provider, model: string | null): void {
  if (model === null) {
    throw new AgentError("resolved no model for adapter opencode");
  }
  const configEnv = harness.env["config_content"];
  // v2: the global `--model` flag does not exist (it prints help), so the
  // model is selected through the inline config override, which merges last
  // over global/project config. Only the *model id* travels in argv; the
  // merge with an existing OPENCODE_CONFIG_CONTENT happens in finalize(),
  // because a caller's inline config may itself contain credentials.
  plan.assign.push([configEnv, MODEL_MARKER + `${provider.opencode_id}/${model}`]);

  // Custom OpenCode provider registration (e.g. Logfare): OpenCode does not
  // know this provider id natively, so the inline config must define it.
  // The block is assembled only from validated config fields; the credential
  // travels as the env NAME (`env: [...]`), which is how OpenCode resolves
  // the key — no secret value enters config content or argv.
  if (provider.opencode_npm) {
    if (!provider.base_url || (!provider.env && !provider.anonymous)) {
      // defensive; loadConfig rejects these combinations
      throw new AgentError(`provider '${provider.key}' lacks base_url/credential for opencode_npm`);
    }
    const models: Record<string, OcModelSpec> = {};
    for (const id of provider.models) {
      const spec = provider.opencode_models[id];
      if (!spec) {
        throw new AgentError(`provider '${provider.key}' has no opencode_models entry for '${id}'`);
      }
      models[id] = spec;
    }
    const block: Record<string, unknown> = {
      npm: provider.opencode_npm,
      name: provider.label,
      env: provider.anonymous ? [] : [provider.env],
      options: { baseURL: provider.opencode_base_url ?? provider.base_url },
      models,
    };
    plan.assign.push([
      configEnv,
      PROVIDER_MARKER + JSON.stringify({ [provider.opencode_id]: block }),
    ]);
  }

  // A running background `opencode` service loads config and credentials
  // from ITS OWN environment, so without a private server both the model
  // above and the provider credential would be ignored (verified: the
  // service keeps answering with the global config model and reports
  // "Model unavailable" for providers it never saw a key for). Force
  // process-scoped `--standalone` unless the caller chose a server mode.
  const passthru = plan.command.slice(1);
  if (passthru.includes("--standalone") || passthru.includes("--server")) {
    return;
  }
  if (passthru.length > 0 && !passthru[0].startsWith("-")) {
    const subcommand = passthru[0];
    if (subcommand === "run" || subcommand === "mini") {
      // subcommands that accept the flag
      plan.command = [plan.command[0], subcommand, "--standalone", ...passthru.slice(1)];
    }
    // other subcommands (models, auth, ...) do not launch a session and
    // are passed through untouched
    return;
  }
  plan.command = [plan.command[0], "--standalone", ...passthru];
}

// ---------------------------------------------------------------------------
// Execution (child process with inherited stdio; no execve in Bun)
// ---------------------------------------------------------------------------

const SIGNAL_NUMBERS: Record<string, number> = osConstants.signals as unknown as Record<
  string,
  number
>;

/** A Windows batch shim (.cmd/.bat, e.g. npm's cmd-shim output) cannot be
 * started by CreateProcess/Bun.spawn directly; it needs cmd.exe. */
function isBatchShim(path: string): boolean {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(path);
}

/**
 * Build the argv used to launch a resolved harness. Batch shims run through
 * cmd.exe, which re-parses its command tail per batch semantics and does not
 * understand the backslash-escaped quotes that CreateProcess argv
 * serialization produces — so the fully quoted command line travels through
 * an environment variable and is expanded by cmd itself (quotes in the
 * expanded text toggle cmd's quoting state, keeping `& | < > ( )` and spaces
 * inside quoted arguments literal). Double quotes and `%` cannot be
 * represented faithfully at all; those arguments are rejected up front
 * (fail closed) instead of risking corruption or injection.
 */
function launchArgv(
  resolved: string,
  args: string[],
  env: Record<string, string>
): string[] {
  if (!isBatchShim(resolved)) {
    return [resolved, ...args];
  }
  if (resolved.includes("%")) {
    throw new AgentError(
      `harness path '${resolved}' contains '%' which cannot be passed safely ` +
        "through cmd.exe; move the harness to a path without '%'",
      EXIT_RUNTIME
    );
  }
  for (const arg of args) {
    if (/["%\r\n]/.test(arg)) {
      throw new AgentError(
        `harness argument ${JSON.stringify(arg)} contains \" or % which cannot be passed ` +
          "safely through a Windows batch shim (.cmd/.bat); remove it from the " +
          "harness arguments or invoke the harness directly",
        EXIT_RUNTIME
      );
    }
  }
  const quote = (arg: string): string =>
    arg === "" || /[\s&|<>^(),;]/.test(arg) ? `"${arg}"` : arg;
  env["AGENT_LAUNCH_CMD"] = [resolved, ...args].map(quote).join(" ");
  const comspec = process.env.ComSpec || "cmd.exe";
  return [comspec, "/d", "/c", "%AGENT_LAUNCH_CMD%"];
}

async function runInherited(cmd: string[], env?: Record<string, string | undefined>): Promise<number> {
  const child = Bun.spawn({
    cmd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ["SIGINT", forward("SIGINT")],
    ["SIGTERM", forward("SIGTERM")],
    ["SIGHUP", forward("SIGHUP")],
  ];
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  try {
    await child.exited;
  } finally {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  }
  const signalCode = (child as unknown as { signalCode?: string | null }).signalCode;
  if (signalCode) {
    const number = SIGNAL_NUMBERS[signalCode];
    return number ? 128 + number : 1;
  }
  return child.exitCode ?? 0;
}

function needsInjection(plan: Plan): boolean {
  if (plan.require_infisical) {
    // Never trust an ambient value for these routes: always let Infisical
    // provide (or fail to provide) the credential inside the wrapper.
    return true;
  }
  for (const [envName, secretName] of plan.require_cred) {
    if (process.env[envName] || process.env[secretName]) {
      continue;
    }
    return true;
  }
  return false;
}

async function startViaWithSecrets(plan: Plan, baseline: string[]): Promise<number> {
  const wrapper = withSecretsPath();
  if (IS_WINDOWS && wrapper.endsWith(".ps1")) {
    if (!existsSync(wrapper)) {
      throw new AgentError(`missing dotfiles wrapper: ${wrapper}`, EXIT_RUNTIME);
    }
  } else {
    try {
      accessSync(wrapper, fsConstants.X_OK);
    } catch {
      throw new AgentError(`missing dotfiles wrapper: ${wrapper}`, EXIT_RUNTIME);
    }
  }
  const payload = [process.execPath, realpathSync(import.meta.path), "__exec"];
  payload.push("--baseline", baseline.join(","));
  payload.push("--keep", [...plan.keep].sort().join(","));
  payload.push("--drop", [...new Set(plan.drop)].join(","));
  for (const name of plan.unset) {
    payload.push("--unset", name);
  }
  for (const [dst, src] of plan.copy) {
    payload.push("--copy", `${dst}=${src}`);
  }
  for (const [name, value] of plan.assign) {
    payload.push("--assign", `${name}=${value}`);
  }
  for (const [envName, secretName] of plan.require_cred) {
    payload.push("--cred", `${envName}=${secretName}`);
  }
  if (plan.omp_guard) {
    payload.push("--omp-guard-id", plan.omp_guard.providerId);
    payload.push("--omp-guard-env", plan.omp_guard.envName);
    if (plan.omp_guard.agentDir) payload.push("--omp-guard-agent-dir", plan.omp_guard.agentDir);
    if (plan.omp_guard.modelsPath) payload.push("--omp-guard-models", plan.omp_guard.modelsPath);
    if (plan.omp_guard.modelsSha256) payload.push("--omp-guard-models-sha", plan.omp_guard.modelsSha256);
  }
  payload.push("--", ...plan.command);

  // require_infisical routes must not inherit an ambient credential: remove
  // the route's credential names from the wrapper's environment so only
  // Infisical can supply them. A missing Infisical secret then fails inside
  // the wrapper instead of silently reusing the shell value.
  let wrapperEnv: Record<string, string> | undefined;
  if (plan.require_infisical) {
    const strip = new Set<string>();
    for (const [envName, secretName] of plan.require_cred) {
      strip.add(envName);
      strip.add(secretName);
    }
    wrapperEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || strip.has(name)) continue;
      wrapperEnv[name] = value;
    }
  }
  const childEnv = wrapperEnv ?? process.env;

  if (IS_WINDOWS && wrapper.endsWith(".ps1")) {
    const shell = which("pwsh") ? "pwsh" : "powershell";
    return runInherited(
      [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...payload],
      childEnv
    );
  }
  return runInherited([wrapper, ...payload], childEnv);
}

/**
 * Parse an existing inline-config env value into an object. A caller's
 * unusable value warns and yields an empty object (never a crash): the
 * launcher's own keys are then written into a fresh object.
 */
function readInlineConfig(env: Record<string, string>, name: string): Record<string, unknown> {
  const raw = env[name];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`agent: warning: existing ${name} is not valid JSON; replacing it`);
    return {};
  }
  if (isPlainObject(parsed)) return parsed;
  console.error(`agent: warning: existing ${name} is not an object; replacing it`);
  return {};
}

async function finalize(plan: Plan): Promise<number> {
  const baseline = new Set(plan.baseline ?? Object.keys(process.env));
  const keep = plan.keep;
  const drop = new Set(plan.drop);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (keep.has(name)) {
      env[name] = value;
    } else if (drop.has(name)) {
      continue;
    } else if (!baseline.has(name)) {
      // injected by script/with-secrets but not selected by this route
      continue;
    } else {
      env[name] = value;
    }
  }

  for (const name of plan.unset) {
    delete env[name];
  }

  for (const [dst, src] of plan.copy) {
    const value = env[dst] || env[src];
    if (value) {
      env[dst] = value;
    }
  }

  for (const [envName, secretName] of plan.require_cred) {
    if (!env[envName] && !env[secretName]) {
      throw new AgentError(
        `missing credential: set ${envName} or provide Infisical secret ${secretName} ` +
          "in environment `dev` (script/with-secrets)",
        EXIT_RUNTIME
      );
    }
  }

  for (const [name, value] of plan.assign) {
    if (value.startsWith(MODEL_MARKER)) {
      const modelId = value.slice(MODEL_MARKER.length);
      const content = readInlineConfig(env, name);
      content["model"] = modelId;
      env[name] = JSON.stringify(content);
    } else if (value.startsWith(PROVIDER_MARKER)) {
      // OpenCode custom-provider block: merge under `provider.<id>` into the
      // same inline config the model marker just touched (assign order is
      // preserved, so the model key is already present).
      const payload = value.slice(PROVIDER_MARKER.length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new AgentError(
          `internal: invalid provider payload for ${name}`,
          EXIT_RUNTIME
        );
      }
      if (!isPlainObject(parsed)) {
        throw new AgentError(
          `internal: provider payload for ${name} must be an object`,
          EXIT_RUNTIME
        );
      }
      const content = readInlineConfig(env, name);
      const existing = content["provider"];
      if (existing !== undefined && !isPlainObject(existing)) {
        console.error(`agent: warning: existing ${name} provider is not an object; replacing it`);
      }
      const providers: Record<string, unknown> = isPlainObject(existing) ? existing : {};
      Object.assign(providers, parsed);
      content["provider"] = providers;
      env[name] = JSON.stringify(content);
    } else if (value.startsWith(CRED_MARKER)) {
      const source = value.slice(CRED_MARKER.length);
      const resolved = env[source];
      if (!resolved) {
        throw new AgentError(`missing credential ${source} for ${name}`, EXIT_RUNTIME);
      }
      env[name] = resolved;
    } else {
      env[name] = value;
    }
  }

  const command = plan.command;
  const resolvedCmd = which(command[0], env["PATH"]);
  if (!resolvedCmd) {
    throw new AgentError(
      `harness not found: ${command[0]} (install it via pc-setup/mise)`,
      EXIT_RUNTIME
    );
  }
  return runInherited(launchArgv(resolvedCmd, command.slice(1), env), env);
}

interface ExecStagePlan {
  command: string[];
  keep: Set<string>;
  copy: Array<[string, string]>;
  unset: string[];
  assign: Array<[string, string]>;
  require_cred: Array<[string, string]>;
  drop: string[];
  baseline: string[];
}

function cmdExec(argv: string[]): Promise<number> {
  // Stage 2, running inside script/with-secrets: parse the plan tokens and
  // exec the harness with the filtered environment.
  let baseline: string[] | null = null;
  let keep = new Set<string>();
  let drop: string[] = [];
  let unset: string[] = [];
  let copy: Array<[string, string]> = [];
  let assign: Array<[string, string]> = [];
  let cred: Array<[string, string]> = [];
  let ompGuardId: string | null = null;
  let ompGuardEnv: string | null = null;
  let ompGuardAgentDir: string | null = null;
  let ompGuardModelsPath: string | null = null;
  let ompGuardModelsSha: string | null = null;
  let command: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      command = argv.slice(index + 1);
      break;
    }
    if (token === "--baseline") {
      baseline = argv[index + 1] ? argv[index + 1].split(",") : [];
    } else if (token === "--keep") {
      keep = new Set(argv[index + 1] ? argv[index + 1].split(",") : []);
    } else if (token === "--drop") {
      drop = argv[index + 1] ? argv[index + 1].split(",") : [];
    } else if (token === "--unset") {
      unset.push(argv[index + 1]);
    } else if (token === "--copy") {
      const [dst, src] = argv[index + 1].split("=", 2);
      copy.push([dst, src]);
    } else if (token === "--assign") {
      const raw = argv[index + 1];
      const eq = raw.indexOf("=");
      assign.push([raw.slice(0, eq), raw.slice(eq + 1)]);
    } else if (token === "--cred") {
      const raw = argv[index + 1];
      const eq = raw.indexOf("=");
      cred.push([raw.slice(0, eq), raw.slice(eq + 1)]);
    } else if (token === "--omp-guard-id") {
      ompGuardId = argv[index + 1];
    } else if (token === "--omp-guard-env") {
      ompGuardEnv = argv[index + 1];
    } else if (token === "--omp-guard-agent-dir") {
      ompGuardAgentDir = argv[index + 1];
    } else if (token === "--omp-guard-models") {
      ompGuardModelsPath = argv[index + 1];
    } else if (token === "--omp-guard-models-sha") {
      ompGuardModelsSha = argv[index + 1];
    } else {
      throw new AgentError(`__exec: unexpected token '${token}'`);
    }
    index += 2;
  }
  if (command.length === 0) {
    throw new AgentError("__exec: no command given");
  }
  if (baseline === null) {
    throw new AgentError("__exec: --baseline is required");
  }
  if (ompGuardId !== null || ompGuardEnv !== null) {
    if (!ompGuardId || !ompGuardEnv) {
      throw new AgentError("__exec: --omp-guard-id and --omp-guard-env must be passed together");
    }
    // Re-check immediately before spawn: OMP config/dotenv/auth files may
    // have changed after the pre-fetch check (TOCTOU). Still not atomic with
    // OMP's own read, but the window is reduced to the final exec. The
    // omp_guard flags exist only on require_infisical routes, so the
    // implicit-switch recheck is too; other omp routes check at plan time.
    guardOmpImplicitSwitch(
      ompGuardId,
      ompGuardAgentDir ?? undefined
    );
    const customGuard =
      ompGuardAgentDir && ompGuardModelsPath && ompGuardModelsSha
        ? { agentDir: ompGuardAgentDir, modelsPath: ompGuardModelsPath, modelsSha256: ompGuardModelsSha }
        : undefined;
    guardOmpCredentialSource(ompGuardId, ompGuardEnv, customGuard);
  }
  const stage: ExecStagePlan = { command, keep, copy, unset, assign, require_cred: cred, drop, baseline };
  return finalize(stage as unknown as Plan);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function usageText(): string {
  return USAGE.replace("{config_path}", configPath()).replace("{with_secrets}", withSecretsPath());
}

function requireHarness(config: Config, harnessKey: string): Harness {
  if (harnessKey === "pi") {
    throw new AgentError(
      "the Pi Worker slot moved to OMP; use 'agent omp <provider>' (native 'pi' " +
        "is still available outside the launcher)"
    );
  }
  const harness = config.harnesses[harnessKey];
  if (!harness) {
    const known = Object.keys(config.harnesses).sort().join(", ");
    throw new AgentError(`unknown harness '${harnessKey}'; known harnesses: ${known}`);
  }
  return harness;
}

function selectRoute(config: Config, harnessKey: string, providerKey: string): [Harness, Provider, Route] {
  const harness = requireHarness(config, harnessKey);
  const provider = config.providers[providerKey];
  if (!provider) {
    const known = Object.keys(config.providers).sort().join(", ");
    throw new AgentError(
      `unknown provider '${providerKey}'; known providers: ${known}; ` +
        "(harness arguments go after '--'; `agent <harness>` needs no provider)"
    );
  }
  const route = config.routes[`${harnessKey}.${providerKey}`];
  if (!route) {
    const available = Object.keys(config.routes)
      .filter((key) => key.startsWith(harnessKey + "."))
      .map((key) => splitRouteKey(key)[1])
      .sort()
      .join(", ");
    throw new AgentError(
      `no route for harness '${harnessKey}' with provider '${providerKey}'; ` +
        `available providers for '${harnessKey}': ${available || "(none)"}`
    );
  }
  return [harness, provider, route];
}

async function cmdRun(
  config: Config,
  harnessKey: string,
  providerKey: string,
  cliModel: string | null,
  passthru: string[]
): Promise<number> {
  const [harness, provider, route] = selectRoute(config, harnessKey, providerKey);
  let model: string | null;
  if (harness.adapter === "passthrough") {
    if (cliModel !== null) {
      throw new AgentError(
        `harness '${harnessKey}' (adapter passthrough) does not accept --model via ${PROGRAM}; ` +
          "select the model inside the harness"
      );
    }
    model = null;
  } else {
    model = resolveModel(route, provider, cliModel);
  }
  const plan = buildPlan(config, harness, provider, route, model, passthru);

  if (which(harness.command) === null) {
    throw new AgentError(
      `harness not found: ${harness.command} (install it via pc-setup/mise)`,
      EXIT_RUNTIME
    );
  }

  if (needsInjection(plan)) {
    return startViaWithSecrets(plan, Object.keys(process.env).sort());
  }
  return finalize(plan);
}

function cmdRunShortcut(config: Config, name: string, argv: string[]): Promise<number> {
  const [harnessKey, providerKey] = resolveShortcut(config, name);
  const { model, passthru } = parseShortcutArgs(argv);
  return cmdRun(config, harnessKey, providerKey, model, passthru);
}

function cmdRunNative(config: Config, harnessKey: string, passthru: string[]): Promise<number> {
  // Native mode: no provider, no route, no Plan — the environment is passed
  // through exactly as-is (nothing injected, filtered or unset), matching
  // the contract of running the harness directly (subscription login,
  // harness-owned auth/model), plus the launcher's resolution, argument
  // guard and exit-code/signal handling.
  const harness = requireHarness(config, harnessKey);
  checkPassthru(passthru, harness);
  console.error(
    `${PROGRAM}: no provider given — running native '${harnessKey}' ` +
      "(no endpoint/model/credential injection)"
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  const resolvedCmd = which(harness.command, env["PATH"]);
  if (!resolvedCmd) {
    throw new AgentError(
      `harness not found: ${harness.command} (install it via pc-setup/mise)`,
      EXIT_RUNTIME
    );
  }
  return runInherited(launchArgv(resolvedCmd, passthru, env), env);
}

function cmdList(config: Config): number {
  const header = `${"ROUTE".padEnd(22)} ${"SHORTCUT".padEnd(22)} ${"DEFAULT MODEL".padEnd(26)} NOTES`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const key of Object.keys(config.routes).sort()) {
    const route = config.routes[key];
    const provider = config.providers[route.provider];
    const defaultModel = routeDefaultModel(route, provider);
    const cell = defaultModel ?? "--model required";
    let notes = route.note || "";
    if (defaultModel === null) {
      notes = `(explicit --model) ${notes}`.trimEnd();
    }
    console.log(
      `${key.padEnd(22)} ${shortcutName(route.harness, route.provider).padEnd(22)} ` +
        `${cell.padEnd(26)} ${notes}`.trimEnd()
    );
  }
  console.log("");
  console.log("models per route are validated against config/agents.toml; run");
  console.log("'agent models <provider>' for credential names and the full list.");
  console.log("'agent shortcuts' shows which shortcut commands are linked.");
  return 0;
}

function cmdModels(config: Config, providerKey: string): number {
  const provider = config.providers[providerKey];
  if (!provider) {
    const known = Object.keys(config.providers).sort().join(", ");
    throw new AgentError(`unknown provider '${providerKey}'; known providers: ${known}`);
  }
  console.log(`provider: ${provider.key} (${provider.label})`);
  if (provider.base_url) {
    if (provider.opencode_npm) {
      // Both spellings matter when they differ: the Anthropic adapter appends
      // /v1/messages itself, while the OpenCode block uses opencode_base_url.
      const anthropicSpelling = provider.base_url;
      const opencodeSpelling = provider.opencode_base_url ?? provider.base_url;
      console.log(`opencode endpoint: ${opencodeSpelling} (OpenAI-compatible custom provider)`);
      if (opencodeSpelling !== anthropicSpelling) {
        console.log(`anthropic endpoint: ${anthropicSpelling} (base_url; /v1/messages appended)`);
      }
    } else {
      console.log(`anthropic endpoint: ${provider.base_url}`);
    }
  }
  if (provider.opencode_npm) {
    console.log(`opencode custom provider: ${provider.opencode_npm} (id ${provider.opencode_id})`);
  }
  if (provider.secret) {
    const note = provider.require_infisical
      ? " [require_infisical: always sourced from Infisical; ambient env and OMP-local overrides are rejected]"
      : "";
    console.log(`credential: Infisical secret ${provider.secret} -> env ${provider.env}${note}`);
  } else if (provider.anonymous) {
    console.log(
      "credential: none (anonymous free tier; no secret is fetched and no credential env reaches the child)"
    );
  } else {
    console.log("credential: harness-native login (no Infisical secret)");
  }
  if (provider.models.length > 0) {
    console.log(`opencode model id example: ${provider.opencode_id}/${provider.models[0]}`);
  } else {
    console.log(`opencode model id format: ${provider.opencode_id}/<model>`);
  }
  console.log(`omp provider id: ${provider.omp_id}`);
  const routes = Object.values(config.routes)
    .filter((r) => r.provider === providerKey)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  console.log("routes:");
  for (const route of routes) {
    const harness = config.harnesses[route.harness];
    const defaultModel = routeDefaultModel(route, provider);
    const suffix = defaultModel ? ` (default ${defaultModel})` : " (--model required)";
    console.log(`  ${route.key.padEnd(22)} [${harness.adapter}]${suffix}`);
    if (route.note) {
      console.log(`    note: ${route.note}`);
    }
    if (route.models !== null && JSON.stringify(route.models) !== JSON.stringify(provider.models)) {
      console.log("    models (route overrides provider):");
      for (const model of route.models) {
        console.log(`      ${model}`);
      }
    }
  }
  console.log("models:");
  for (const model of provider.models) {
    const markers: string[] = [];
    if (model === provider.default_model) {
      markers.push("provider default");
    }
    for (const route of routes) {
      if (model === routeDefaultModel(route, provider)) {
        markers.push(`default for ${route.harness}`);
      }
      if (route.models !== null && !route.models.includes(model)) {
        const marker = `not for ${route.harness}`;
        if (!markers.includes(marker)) {
          markers.push(marker);
        }
      }
    }
    const suffix = markers.length > 0 ? `   [${markers.join("; ")}]` : "";
    console.log(`  ${model}${suffix}`);
  }
  if (provider.models.length === 0) {
    console.log("  (none declared; any id passes through unvalidated)");
  }
  return 0;
}

function cmdCheck(config: Config): number {
  // Validate every declared fallback profile, not just the provider/route
  // tables: a malformed profile (bad primary_route, bad cap, bad billing) must
  // fail CI here rather than at `agent fallback` time with a stack trace.
  let profileCount = 0;
  try {
    const parsedToml = parseTomlTable(readFileSync(config.path, "utf8"), config.path);
    for (const id of listFallbackProfiles(parsedToml)) {
      parseFallbackProfile(parsedToml, id);
      profileCount++;
    }
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_USAGE);
    }
    throw error;
  }
  console.log(
    `config OK: ${config.path} ` +
      `(${Object.keys(config.providers).length} providers, ` +
      `${Object.keys(config.harnesses).length} harnesses, ` +
      `${Object.keys(config.routes).length} routes, ` +
      `${profileCount} fallback profiles)`
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Progressive disclosure (issue #88): help --json / guide / routes
// ---------------------------------------------------------------------------

/** `agent help --json`: the usage text plus its subcommand index as JSON. */
function cmdHelpJson(config: Config): number {
  console.log(redactJson(buildHelpData(usageText())));
  return 0;
}

/**
 * `agent guide [topic] [--json]`: progressive disclosure. The overview lists
 * the topics; each topic is read on demand — no giant always-on prompt.
 */
function cmdGuide(argv: string[]): number {
  const json = argv.includes("--json");
  const rest = argv.filter((token) => token !== "--json");
  if (rest.length > 1) {
    throw new AgentError("usage: agent guide [topic] [--json]");
  }
  const topic = rest[0] ?? null;
  let data;
  try {
    data = buildGuideData(topic);
  } catch (error) {
    if (error instanceof UnknownGuideTopicError) {
      throw new AgentError(error.message);
    }
    throw error;
  }
  console.log(json ? redactJson(data) : renderGuideText(data));
  return 0;
}

/**
 * `agent routes [--json]`: every configured route with its catalog facts
 * (quota scope, rate limits, restrictions, e2e evidence). Unknown stays
 * unknown; readiness/usage/reset/recommendation are marked not-yet-available
 * (issues #90/#91/#94). A malformed [catalog.*] table fails closed (exit 1).
 */
function cmdRoutes(config: Config, argv: string[]): number {
  if (argv.filter((token) => token !== "--json").length > 0) {
    throw new AgentError("usage: agent routes [--json]");
  }
  let catalog;
  try {
    catalog = loadCatalog(config.path);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }
  const data = buildRoutesData(config, catalog);
  console.log(argv.includes("--json") ? redactJson(data) : renderRoutesText(data));
  return 0;
}

/**
 * `agent fallback <profile-id> [--json]`: resolve and display an opt-in
 * continuity profile (issue #136). Shows usable candidates, rejected candidates
 * with reasons, and overall status. Does not execute any fallback — only
 * validates the profile against current catalog and attestation state.
 */
function cmdFallback(config: Config, profileId: string, json: boolean): number {
  // Parse profile from config using Bun's native TOML parser
  const tomlText = readFileSync(config.path, "utf-8");
  const parsedToml = parseTomlTable(tomlText, config.path);

  // A malformed profile must surface as a normal launcher error, not a raw
  // ContractError stack trace (parseFallbackProfile throws on bad identity,
  // billing, scope or cap).
  let profile;
  try {
    profile = parseFallbackProfile(parsedToml, profileId);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }
  if (!profile) {
    throw new AgentError(`fallback profile not found: ${profileId}`);
  }

  // The validated [catalog.*] tables are the authority for a provider's real
  // billing model and shared allowance. A malformed catalog fails closed.
  let catalogFacts;
  try {
    catalogFacts = loadCatalog(config.path);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }
  const catalogLike = buildFallbackCatalog(config, catalogFacts);

  // Durable committed evidence first, then ephemeral local probe state (which
  // wins: a fresher observation supersedes the reviewed record).
  const attestationMap = mergeAttestations(
    seedAttestationsFromCatalog(catalogFacts),
    loadCatalogAttestations(),
  );

  // Get primary quota scope for cross-candidate validation
  const primaryQuotaScope = getPrimaryQuotaScope(catalogFacts, profile.primaryRoute);

  // Resolve profile. A ContractError here (malformed profile identity, or a
  // caller-supplied crafted profile) must surface as a normal launcher error
  // rather than a raw stack trace.
  let resolution;
  try {
    resolution = resolveFallbackProfile(
      profile,
      catalogLike,
      attestationMap,
      primaryQuotaScope,
    );
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }

  if (json) {
    console.log(redactJson(resolution));
  } else {
    console.log(renderFallbackResolution(resolution));
  }
  return 0;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * `agent task run|status`: the thin CLI entrypoint issue #100 specifies for
 * Herdr dispatch. `run` goes through runTaskToCompletion — dispatch, prompt
 * with the opt-in fallback profile's candidate execution, and collect from
 * the worker that actually served. `status` reads the durable task state.
 * The task modules are imported lazily so the launcher stays importable
 * without dragging the Herdr/task stack into `agent check` etc.
 */
async function cmdTask(
  config: Config,
  sub: string,
  arg: string | Record<string, unknown> | undefined,
  opts?: Record<string, unknown>,
): Promise<number> {
  const task = await import("./agent/task.ts");
  if (sub === "status") {
    const taskId = arg as string;
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new AgentError(`invalid task id '${taskId}'`, EXIT_USAGE);
    }
    const status = task.getTaskStatus(taskId);
    if (!status) {
      console.log(`no task state for '${taskId}'`);
      return EXIT_RUNTIME;
    }
    console.log(redactJson(status));
    return 0;
  }
  // sub === "run"
  const route = arg as string;
  const o = (opts ?? {}) as {
    model: string | null; fallback: string | null; prompt: string | null;
    accept: string[]; timeoutMs: number | null;
  };
  const routeObj = config.routes[route];
  if (!routeObj) {
    throw new AgentError(`route not configured: ${route}`, EXIT_USAGE);
  }
  const provider = config.providers[routeObj.provider];
  const model = o.model ?? routeObj.default_model ?? provider?.default_model ?? null;
  if (!model) {
    throw new AgentError(
      `no model for route '${route}'; pass --model <id>`, EXIT_USAGE,
    );
  }
  let prompt = o.prompt;
  if (prompt === null && !process.stdin.isTTY) {
    prompt = await Bun.stdin.text();
  }
  if (prompt === null || !prompt.trim()) {
    throw new AgentError(
      "no task prompt; pass --prompt <text> or pipe the prompt on stdin",
      EXIT_USAGE,
    );
  }
  // Fail fast with a clear message instead of a ContractError stack when
  // Herdr itself is unavailable.
  const { checkHerdrAvailable } = await import("./agent/herdr.ts");
  const herdr = await checkHerdrAvailable();
  if (!herdr.available) {
    throw new AgentError(
      `Herdr is not available (${herdr.error ?? "unknown"}); task dispatch requires Herdr`,
      EXIT_RUNTIME,
    );
  }
  const taskId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const result = await task.runTaskToCompletion(config, {
    id: taskId,
    route,
    model,
    prompt: prompt.trim(),
    ...(o.fallback ? { profileId: o.fallback } : {}),
    ...(o.accept.length > 0 ? { acceptanceCriteria: o.accept } : {}),
    ...(o.timeoutMs !== null ? { timeoutMs: o.timeoutMs } : {}),
  });
  console.log(redactJson({
    taskId: result.taskId,
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.result !== undefined ? { result: result.result } : {}),
  }));
  return result.success ? 0 : EXIT_RUNTIME;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length > 0 && argv[0] === "__exec") {
    return cmdExec(argv.slice(1));
  }

  // Shortcut form via direct invocation: `<harness>-<provider> [args...]`.
  // The invoked file name is recovered from the kernel-level argv (Bun
  // resolves symlinked argv[1]); native harness commands never come through
  // here (they are separate binaries).
  const invoked = invokedScriptPath(LAUNCHER_BASENAME);
  if (invoked) {
    const name = basename(invoked);
    if (
      name !== LAUNCHER_BASENAME &&
      name !== "agent" &&
      name !== "bun" &&
      name.includes("-")
    ) {
      const config = loadConfig();
      // exact match against the routes; anything else raises "unknown
      // shortcut" before a process starts
      return cmdRunShortcut(config, name, argv);
    }
  }

  if (argv.length === 0) {
    console.error(usageText());
    return EXIT_USAGE;
  }

  // Portable shortcut spelling: `agent opencode-zen [args...]`
  const config = loadConfig();
  const first = argv[0];
  if (
    !["help", "--help", "-h", "--version", "-V", "list", "check", "models", "shortcuts"].includes(first) &&
    !(first in config.harnesses) &&
    shortcutMap(config)[first]
  ) {
    return cmdRunShortcut(config, first, argv.slice(1));
  }

  // Progressive-disclosure subcommands (issue #88). A configured harness
  // named `guide`/`routes` always wins, keeping its native launch path.
  if ((first === "guide" || first === "routes") && !(first in config.harnesses)) {
    if (first === "guide") {
      return cmdGuide(argv.slice(1));
    }
    return cmdRoutes(config, argv.slice(1));
  }

  const action = parseArgs(argv);
  if (action[0] === "help") {
    const [, json] = action;
    if (json) {
      return cmdHelpJson(config);
    }
    console.log(usageText());
    return 0;
  }
  if (action[0] === "version") {
    console.log(`${PROGRAM} (dotfiles launcher, config: ${configPath()})`);
    return 0;
  }
  if (action[0] === "list") {
    return cmdList(config);
  }
  if (action[0] === "check") {
    return cmdCheck(config);
  }
  if (action[0] === "models") {
    return cmdModels(config, action[1]);
  }
  if (action[0] === "shortcuts") {
    return cmdShortcuts(config, action[1], launcherLinkTarget());
  }
  if (action[0] === "fallback") {
    const [, profileId, json] = action;
    return cmdFallback(config, profileId, json);
  }
  if (action[0] === "task") {
    return cmdTask(config, action[1], action[2], action[3]);
  }
  if (action[0] === "native") {
    const [, harnessKey, nativePassthru] = action;
    return cmdRunNative(config, harnessKey, nativePassthru);
  }
  const [, harnessKey, providerKey, model, passthru] = action;
  return cmdRun(config, harnessKey, providerKey, model, passthru);
}

// Run the CLI only when this module is the process entry point. Other
// modules (script/agent/*.ts) import the config surface above; without this
// guard, importing them would execute the launcher and exit the process.
if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof AgentError) {
      console.error(`${PROGRAM}: ${error.message}`);
      process.exit(error.code);
    }
    throw error;
  }
}
