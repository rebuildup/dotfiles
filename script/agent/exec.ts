#!/usr/bin/env bun
/**
 * Exec staging for the agent launcher: the argv/env markers that carry the
 * plan into the `__exec` child stage, PATH/batch-shim resolution, the
 * with-secrets (Infisical) wrapper stage, inline-config merge, and the
 * final spawn. Extracted from script/agent.ts; Plan is imported type-only
 * (no runtime cycle).
 */

import { constants as osConstants } from "node:os";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "./contract.ts";
import { AgentError, EXIT_RUNTIME } from "./errors.ts";
import { guardOmpCredentialSource, guardOmpImplicitSwitch } from "./omp.ts";
import { IS_WINDOWS, which } from "./util.ts";
import { dotfilesRepoRoot } from "./util.ts";
import type { Plan } from "./plan.ts";

// argv-safe assign marker handled inside the child stage: only the model id
// crosses argv, the surrounding config is merged from the environment.
export const MODEL_MARKER = "@@model:";
// argv-safe marker for the OpenCode custom-provider block: the payload is a
// JSON object mapping the provider id to its block (npm package, endpoint
// URL, credential env NAME, model specs). It never contains a credential
// value — OpenCode reads the key from the named env var — so it is safe to
// carry in argv like every other plan token.
export const PROVIDER_MARKER = "@@provider:";
// argv-safe marker for "copy this secret from another env name"; kept
// distinct from a bare `@` so real model ids that start with `@`
// (e.g. Cloudflare's `@cf/...`) pass through as literal values.
export const CRED_MARKER = "@@cred:";

export function withSecretsPath(): string {
  return (
    process.env.AGENT_WITH_SECRETS ||
    join(dotfilesRepoRoot(), "script", IS_WINDOWS ? "with-secrets.ps1" : "with-secrets")
  );
}

// ---------------------------------------------------------------------------
// Execution (child process with inherited stdio; no execve in Bun)
// ---------------------------------------------------------------------------

const SIGNAL_NUMBERS: Record<string, number> = Object.fromEntries(
  Object.entries(osConstants.signals),
);

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
export function launchArgv(
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

export async function runInherited(cmd: string[], env?: Record<string, string | undefined>): Promise<number> {
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
  const signalCode = child.signalCode;
  if (signalCode) {
    const number = SIGNAL_NUMBERS[signalCode];
    return number ? 128 + number : 1;
  }
  return child.exitCode ?? 0;
}

export function needsInjection(plan: Plan): boolean {
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

export async function startViaWithSecrets(plan: Plan, baseline: string[], launcherTarget: string): Promise<number> {
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
  const payload = [process.execPath, launcherTarget, "__exec"];
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

export async function finalize(plan: ExecStagePlan): Promise<number> {
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
  baseline: string[] | null;
}

export function cmdExec(argv: string[]): Promise<number> {
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
  return finalize(stage);
}

