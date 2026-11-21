#!/usr/bin/env bun
/**
 * OMP provider integration for the agent launcher: managed models.yml
 * profiles, worker argv construction, and the pre-spawn credential/source
 * guards. Extracted from script/agent.ts; the launcher's Plan/Provider/
 * Harness types are imported type-only (no runtime cycle).
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { errnoCode, errorMessage, isPlainObject } from "./contract.ts";
import { AgentError, EXIT_RUNTIME } from "./errors.ts";
import type { Harness, Provider } from "./config.ts";
import type { Plan } from "./plan.ts";


const OMP_DESTRUCTIVE_GUARD = "omp-destructive-guard.ts";
const OMP_WORKER_OVERLAY = "omp-worker-overlay.yml";
const OMP_WORKER_TOOLS = "read,bash,edit,write";

// ---------------------------------------------------------------------------
// OMP custom providers (models.yml under a launcher-owned --profile)
// ---------------------------------------------------------------------------
//
// OMP has no native provider id for some OpenAI-compatible endpoints
// (Logfare, Requesty, ModelScope, OVHcloud). OMP's documented extension point
// is `<agentDir>/models.yml`, and `--profile <name>` isolates the whole agent
// dir at ~/.omp/profiles/<name>/agent. The launcher therefore generates a
// models.yml inside a `dotfiles-omp-<provider>` profile and launches OMP with
// that profile: the file is launcher-managed (verified byte-identical on every
// launch, never clobbered), the provider id is the config key, `apiKey`
// references the credential env NAME (the value stays in the environment,
// injected by script/with-secrets), and `auth: none` covers anonymous
// endpoints — the credential-free contract native OMP routes lacked.

const OMP_CUSTOM_PROFILE_PREFIX = "dotfiles-omp-";

export function ompCustomProfileName(providerKey: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerKey)) {
    throw new AgentError(
      `provider key '${providerKey}' cannot name an OMP profile`,
      EXIT_RUNTIME
    );
  }
  return `${OMP_CUSTOM_PROFILE_PREFIX}${providerKey}`;
}

/** Agent dir OMP reads under `--profile dotfiles-omp-<key>`. */
export function ompCustomAgentDir(providerKey: string): string {
  return join(homedir(), ".omp", "profiles", ompCustomProfileName(providerKey), "agent");
}

/** OpenAI-compatible endpoint spelling for the generated models.yml. */
function ompCustomBaseUrl(provider: Provider): string {
  const url = provider.opencode_base_url ?? provider.base_url;
  if (!url) {
    throw new AgentError(
      `provider '${provider.key}' omp_custom requires an OpenAI-compatible base URL`,
      EXIT_RUNTIME
    );
  }
  return url;
}

/**
 * The `apiKey: "!…"` command rendered into a managed models.yml: the
 * repo-shipped helper resolves the named Infisical secret with the canonical
 * self-host flags (never Infisical Cloud).
 */
function ompInfisicalKeyCommand(secretName: string, remoteHome?: string): string {
  const script = remoteHome !== undefined
    ? join(remoteHome, ".dotfiles", "script", "agent", "infisical-key.sh")
    : join(import.meta.dir, "infisical-key.sh");
  return `${script} ${secretName}`;
}

function ompModelLimits(provider: Provider, modelId: string): { contextWindow?: number; maxTokens?: number } {
  const spec = provider.omp_models[modelId];
  if (spec) return { contextWindow: spec.context, maxTokens: spec.output };
  const oc = provider.opencode_models[modelId];
  if (oc) return { contextWindow: oc.limit.context, maxTokens: oc.limit.output };
  return {};
}

/** Whether an OMP route needs a launcher-managed profile:
 * omp_custom providers always (the file IS the provider definition); native
 * providers only when the credential must come from Infisical
 * (`require_infisical` with a `secret`), so apiKey can resolve inside OMP
 * via `!command` instead of transiting Herdr `--env`. Ambient-credential
 * routes (`require_infisical = false`) keep the env path — unchanged. */
export function ompNeedsManagedProfile(provider: Provider): boolean {
  return provider.omp_custom || (provider.secret !== null && provider.require_infisical);
}

/** Deterministic models.yml content for a managed OMP profile. */
export function renderOmpModelsYaml(provider: Provider, remoteHome?: string): string {
  if (!ompNeedsManagedProfile(provider)) {
    throw new AgentError(
      `provider '${provider.key}' does not need a managed OMP profile`,
      EXIT_RUNTIME
    );
  }
  if (!provider.omp_custom) {
    // Native provider: models.yml only overrides the credential — OMP merges
    // the entry with its built-in provider definition. The `!command` apiKey
    // resolves the Infisical secret inside OMP; it never transits Herdr.
    const secret = provider.secret;
    if (!secret) {
      throw new AgentError(
        `provider '${provider.key}' managed profile requires a secret name`,
        EXIT_RUNTIME
      );
    }
    return [
      "# Managed by the dotfiles agent launcher (config/agents.toml). Do not edit.",
      "providers:",
      `  ${provider.omp_id}:`,
      `    apiKey: ${JSON.stringify(`!${ompInfisicalKeyCommand(secret, remoteHome)}`)}`,
      "",
    ].join("\n");
  }
  const lines: string[] = [
    "# Managed by the dotfiles agent launcher (config/agents.toml). Do not edit.",
    "providers:",
    `  ${provider.key}:`,
    `    baseUrl: ${JSON.stringify(ompCustomBaseUrl(provider))}`,
  ];
  if (provider.anonymous) {
    lines.push('    auth: "none"');
  } else if (provider.secret) {
    // Infisical-backed credential: OMP runs the `!` command and uses its
    // stdout as the key, so the secret travels Infisical -> OMP directly.
    // It never enters Herdr argv (`--env NAME=VALUE`), the pane environment,
    // or the Herdr server — the exposure the env-name form had on the
    // worker path. The env-name form remains for providers whose credential
    // is ambient-only (no Infisical secret name).
    lines.push(
      `    apiKey: ${JSON.stringify(`!${ompInfisicalKeyCommand(provider.secret, remoteHome)}`)}`
    );
  } else {
    const envName = provider.env;
    if (!envName) {
      throw new AgentError(
        `provider '${provider.key}' omp_custom declares no credential env name`,
        EXIT_RUNTIME
      );
    }
    lines.push(`    apiKey: ${JSON.stringify(envName)}`);
  }
  lines.push(`    api: ${JSON.stringify(provider.omp_api ?? "openai-completions")}`);
  lines.push("    models:");
  for (const modelId of provider.models) {
    const limits = ompModelLimits(provider, modelId);
    lines.push(`      - id: ${JSON.stringify(modelId)}`);
    if (limits.contextWindow !== undefined) lines.push(`        contextWindow: ${limits.contextWindow}`);
    if (limits.maxTokens !== undefined) lines.push(`        maxTokens: ${limits.maxTokens}`);
  }
  return lines.join("\n") + "\n";
}

export interface OmpManagedProfile {
  profile: string;
  agentDir: string;
  modelsPath: string;
  /** sha256 of the managed models.yml content, for the pre-spawn recheck. */
  modelsSha256: string;
}

const OMP_MODELS_MANAGED_MARKER = "# Managed by the dotfiles agent launcher";

/**
 * Ensure the launcher-managed models.yml exists and matches what config
 * declares. A file WITHOUT the managed marker is never touched: it is
 * user-owned and could redirect the credential or endpoint. A file WITH the
 * marker but stale content is the launcher's own artifact from an older
 * config/launcher version — it is rewritten atomically so an upgrade (e.g.
 * env-name apiKey -> `!command`) does not wedge every route on a hash
 * mismatch.
 */
export function ensureOmpManagedProfile(provider: Provider): OmpManagedProfile {
  const profile = ompCustomProfileName(provider.key);
  const agentDir = ompCustomAgentDir(provider.key);
  const modelsPath = join(agentDir, "models.yml");
  const content = renderOmpModelsYaml(provider);
  const modelsSha256 = createHash("sha256").update(content).digest("hex");
  mkdirSync(agentDir, { recursive: true });
  if (existsSync(modelsPath)) {
    const existing = readFileSync(modelsPath, "utf8");
    if (existing !== content) {
      if (!existing.startsWith(OMP_MODELS_MANAGED_MARKER)) {
        throw new AgentError(
          `OMP managed models.yml (${modelsPath}) exists without the ` +
            "launcher-managed marker; refusing to overwrite a user-owned file",
          EXIT_RUNTIME
        );
      }
      // Stale launcher-managed artifact: replace with the canonical content.
      const tmp = `${modelsPath}.tmp-${process.pid}`;
      writeFileSync(tmp, content, { mode: 0o600 });
      renameSync(tmp, modelsPath);
    }
  } else {
    writeFileSync(modelsPath, content, { mode: 0o600 });
  }
  return { profile, agentDir, modelsPath, modelsSha256 };
}

/** Absolute real path of the destructive guard shipped next to this launcher.
 * It is loaded with --trusted-extension, which aborts when loading fails, so
 * a missing file must fail before a process starts. */
function ompDestructiveGuardPath(remoteHome?: string): string {
  if (remoteHome !== undefined) {
    // Remote worker: the path must exist on the REMOTE host's dotfiles
    // checkout (~/.dotfiles convention); existence is preflighted by the
    // dispatcher, argv elements are exec'd without shell expansion.
    return join(remoteHome, ".dotfiles", "script", OMP_DESTRUCTIVE_GUARD);
  }
  const candidate = join(import.meta.dir, "..", OMP_DESTRUCTIVE_GUARD);
  try {
    return realpathSync(candidate);
  } catch {
    throw new AgentError(
      `missing OMP destructive guard: ${candidate}; refusing to start without ` +
        "the Worker permission boundary",
      EXIT_RUNTIME
    );
  }
}

/** Absolute real path of the Worker tool-surface overlay shipped next to this
 * launcher. It disables the OMP discovery providers that mount MCP tools
 * (ADR-0014 item 5): `--tools` only filters built-in tools. OMP's strict
 * `--config` loader aborts on a missing file, but the launcher must fail
 * before it builds a command — without the overlay a session would start
 * with MCP servers mounted. */
function ompWorkerOverlayPath(remoteHome?: string): string {
  if (remoteHome !== undefined) {
    return join(remoteHome, ".dotfiles", "script", OMP_WORKER_OVERLAY);
  }
  const candidate = join(import.meta.dir, "..", OMP_WORKER_OVERLAY);
  try {
    return realpathSync(candidate);
  } catch {
    throw new AgentError(
      `missing OMP worker overlay: ${candidate}; refusing to start without ` +
        "the MCP tool-surface boundary",
      EXIT_RUNTIME
    );
  }
}

/** Herdr's OMP integration lives in the OMP agent extension directory.
 * --trusted-extension disables ambient extension discovery, so it must be
 * passed explicitly while the launcher runs inside Herdr. */
function ompHerdrExtensionPath(): string {
  const candidate = join(homedir(), ".omp", "agent", "extensions", "herdr-omp-agent-state.ts");
  try {
    return realpathSync(candidate);
  } catch {
    throw new AgentError(
      `Herdr integration missing: ${candidate}; run 'herdr integration install omp' ` +
        "or start the agent outside Herdr",
      EXIT_RUNTIME
    );
  }
}

/** True when the launcher itself runs inside a Herdr pane. OMP treats any of
 * its pane/tab/workspace variables as inside Herdr, not just HERDR_ENV. */
function insideHerdr(): boolean {
  return (
    process.env.HERDR_ENV === "1" ||
    Boolean(
      process.env.HERDR_PANE_ID ||
        process.env.HERDR_TAB_ID ||
        process.env.HERDR_WORKSPACE_ID
    )
  );
}

const OMP_REX_STATUS = "rex-omp-agent-state.ts";

/** Project-managed OMP extension that reports worker state as OSC 7501
 * program-status records to the enclosing Rex block (ADR-0021). Shipped next
 * to this launcher and loaded with --trusted-extension like the destructive
 * guard; a missing file must fail before a process starts. */
function ompRexStatusPath(remoteHome?: string): string {
  if (remoteHome !== undefined) {
    return join(remoteHome, ".dotfiles", "script", OMP_REX_STATUS);
  }
  const candidate = join(import.meta.dir, "..", OMP_REX_STATUS);
  try {
    return realpathSync(candidate);
  } catch {
    throw new AgentError(
      `missing OMP Rex status extension: ${candidate}; refusing to start ` +
        "a Rex worker without its program-status reporter",
      EXIT_RUNTIME
    );
  }
}

/** True when the launcher itself runs inside a Rex block (interactive
 * `agent omp ...` inside Rex). Worker dispatch passes rexStatus explicitly
 * because the launcher process is not inside the block it creates. */
function insideRex(): boolean {
  return Boolean(
    process.env.REX_BLOCK || process.env.REX_SESSION || process.env.REX_SERVER
  );
}

export interface OmpWorkerPreparation {
  /** `--profile` value for managed-profile providers, else null. */
  profile: string | null;
  /** Managed-profile details for the pre-spawn guard payload. */
  managed: OmpManagedProfile | null;
}

/**
 * Side-effecting preparation for an OMP worker launch, shared by the
 * interactive plan path (`planOmp`) and the Herdr worker path
 * (`script/agent/task.ts`). Runs every check the launcher owns BEFORE a
 * worker process exists:
 *
 * - managed profile (omp_custom, or native require_infisical): generates/
 *   verifies the managed models.yml and rejects ambient OMP_PROFILE /
 *   PI_* / OMP_*_DIR overrides (the launcher passes --profile explicitly);
 * - every omp route: rejects implicit model-switch config;
 * - require_infisical: rejects dotenv/broker/models./stored-credential
 *   overrides that could move the credential source.
 *
 * A Herdr worker cannot re-run these checks inside `__exec` (it is not
 * launched through the with-secrets wrapper), so they run here, immediately
 * before the worker is started.
 */
export function prepareOmpWorker(provider: Provider): OmpWorkerPreparation {
  if (provider.anonymous && !provider.omp_custom) {
    // OMP resolves its credential ladder from env/stored auth; an
    // anonymous route declares no credential env name and the launcher cannot
    // prove OMP sends no key. Fail closed rather than risk a paid path.
    // omp_custom anonymous providers are exempt: the generated models.yml
    // declares `auth: none`, which IS the credential-free contract.
    throw new AgentError(
      `provider '${provider.key}' is anonymous; OMP has no credential-free route ` +
        "contract here, so no omp route may use it unless omp_custom = true " +
        "(models.yml auth: none)"
    );
  }
  // Managed profile: omp_custom (the file IS the provider definition) and
  // native require_infisical providers (the file overrides apiKey so the
  // Infisical secret resolves inside OMP via `!command`, never via Herdr
  // --env). Ambient-credential routes get no profile and keep the env path.
  const managed = ompNeedsManagedProfile(provider)
    ? ensureOmpManagedProfile(provider)
    : null;
  if (managed) {
    // The launcher passes --profile explicitly; an ambient profile/agent-dir
    // override would move OMP to a different agent dir where the managed
    // models.yml does not exist.
    for (const key of OMP_REJECTED_ENV_KEYS) {
      if (key in process.env) {
        throw new AgentError(
          `OMP ${key} is defined in the ambient environment for the ` +
            `managed-profile '${provider.key}' route, which passes --profile ` +
            `${managed.profile} explicitly; unset it or run native \`omp\`.`,
          EXIT_RUNTIME
        );
      }
    }
  }
  // Model-pinning boundary for EVERY omp route, not just require_infisical:
  // agents.toml forbids implicit model fallback on all routes, so
  // omp.openrouter-free must fail closed on a user fallback chain that could
  // move a rate-limited free request to a paid model. The credential-source
  // checks below (dotenv/profile, broker, models., stored credentials) stay
  // require_infisical-only.
  guardOmpImplicitSwitch(provider.omp_id, managed?.agentDir);
  if (provider.require_infisical) {
    const envName = provider.env || provider.secret;
    if (!envName) {
      throw new AgentError(`provider '${provider.key}' declares no credential env name`);
    }
    guardOmpCredentialSource(provider.omp_id, envName, managed ?? undefined);
  }
  return { profile: managed?.profile ?? null, managed };
}

/**
 * The OMP argv for a worker on `provider`/`model`, including the tool-surface
 * hardening every worker gets: the destructive guard and overlay are loaded
 * for Herdr-started workers exactly as for launcher-started ones.
 */
export function ompWorkerArgs(
  provider: Provider,
  model: string,
  prepared: OmpWorkerPreparation,
  options: { rexStatus?: boolean; remoteHome?: string } = {},
): string[] {
  const remoteHome = options.remoteHome;
  const args: string[] = [
    "--provider", provider.omp_id,
    "--model", model,
  ];
  if (prepared.profile) {
    args.push("--profile", prepared.profile);
  }
  if (provider.require_infisical) {
    // Pin the model roles. --models only drives Ctrl+P cycling, so it is not
    // a security allowlist and is intentionally not passed.
    const selector = `${provider.omp_id}/${model}`;
    args.push(
      "--smol", selector,
      "--slow", selector,
      "--plan", selector,
    );
  }
  // Worker tool parity with the former Pi slot: no task sub-agents, web,
  // browser, python or todo tools. --trusted-extension disables ambient
  // extension discovery; the destructive guard (and Herdr, when present) are
  // the only extensions loaded. The overlay disables the discovery providers
  // that would mount MCP servers: --tools only filters built-in tools.
  args.push(
    "--tools", OMP_WORKER_TOOLS,
    "--no-lsp",
    "--no-pty",
    "--no-title",
    "--trusted-extension", ompDestructiveGuardPath(remoteHome),
    "--config", ompWorkerOverlayPath(remoteHome),
  );
  if (insideHerdr() && remoteHome === undefined) {
    args.push("--trusted-extension", ompHerdrExtensionPath());
  }
  // The Rex status reporter is added for Rex-dispatched workers (explicit
  // rexStatus) and for interactive launches already inside a Rex block. It
  // self-disables unless REX_* env is present, so it cannot double-report
  // into Herdr even if both flags were ever combined.
  if (options.rexStatus || (insideRex() && remoteHome === undefined)) {
    args.push("--trusted-extension", ompRexStatusPath(remoteHome));
  }
  return args;
}

export function planOmp(plan: Plan, harness: Harness, provider: Provider, model: string | null): void {
  if (model === null) throw new AgentError("resolved no model for adapter omp");
  const prepared = prepareOmpWorker(provider);
  const args = ompWorkerArgs(provider, model, prepared);
  if (provider.require_infisical) {
    const envName = provider.env || provider.secret;
    if (!envName) {
      throw new AgentError(`provider '${provider.key}' declares no credential env name`);
    }
    plan.omp_guard = {
      providerId: provider.omp_id,
      envName,
      agentDir: prepared.managed?.agentDir ?? null,
      modelsPath: prepared.managed?.modelsPath ?? null,
      modelsSha256: prepared.managed?.modelsSha256 ?? null,
    };
  }
  // A fresh machine's first interactive run otherwise blocks on OMP's setup
  // wizard before the Worker can accept a Herdr prompt. The slot is fully
  // configured by the launcher flags; onboarding choices must not be made
  // implicitly. `omp setup` remains available explicitly outside the launcher.
  plan.assign.push(["OMP_SKIP_SETUP", "1"]);
  plan.command = [harness.command, ...args, ...plan.command.slice(1)];
}

const OMP_REJECTED_ENV_KEYS = [
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
  "OMP_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_CODING_AGENT_DIR",
];

/** The default-profile OMP agent dir. A relocated dir is rejected, never
 * followed: the guard must inspect the directory OMP actually reads. */
function ompAgentDir(): string {
  return join(homedir(), ".omp", "agent");
}

/**
 * Dotenv files OMP loads, in its own order: project cwd `.env`, active agent
 * `.env`, config-root `.env`, home `.env`. OMP only fills keys absent from the
 * process env and mirrors `OMP_*` to `PI_*` within each file, so any
 * assignment is a conflict for an Infisical-backed route. Parsing is
 * line-oriented and never evaluates or expands values.
 */
function readOmpDotenvAssignments(agentDir: string = ompAgentDir()): Array<{ path: string; names: Set<string> }> {
  const files: Array<{ path: string; names: Set<string> }> = [];
  const candidates = [
    join(process.cwd(), ".env"),
    join(agentDir, ".env"),
  ];
  // A named profile's agent dir sits one level below the profile root; OMP
  // may also read a .env there. The default agent dir's parent IS ~/.omp,
  // which is already covered by the fixed entries below.
  const profileRoot = dirname(agentDir);
  if (profileRoot !== join(homedir(), ".omp")) {
    candidates.push(join(profileRoot, ".env"));
  }
  candidates.push(
    join(homedir(), ".omp", ".env"),
    join(homedir(), ".env"),
  );
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      // Only ENOENT proves "no dotenv override". Any other error means the
      // credential source cannot be verified, so the route must not start.
      if (errnoCode(error) === "ENOENT") continue;
      const detail = errorMessage(error);
      throw new AgentError(
        `cannot read OMP dotenv file (${path}): ${detail}; refusing to start ` +
          "because the credential source cannot be verified",
        EXIT_RUNTIME
      );
    }
    const names = new Set<string>();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) names.add(match[1]);
    }
    files.push({ path, names });
  }
  return files;
}

/**
 * Read an OMP config/models file as a mapping. `null` means the file does not
 * exist; empty content means an empty mapping; anything unreadable, invalid,
 * or not a mapping fails closed (the override layer cannot be verified).
 */
function readOmpMapping(
  path: string,
  label: string,
  format: "yaml" | "json"
): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    const detail = errorMessage(error);
    throw new AgentError(
      `cannot read OMP ${label} (${path}): ${detail}; refusing to start because ` +
        "the credential source cannot be verified",
      EXIT_RUNTIME
    );
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = format === "yaml" ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch {
    throw new AgentError(
      `invalid ${format.toUpperCase()} in OMP ${label} (${path}); refusing to start ` +
        "because the credential source cannot be verified",
      EXIT_RUNTIME
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new AgentError(
      `OMP ${label} (${path}) is not a mapping; refusing to start because the ` +
        "credential source cannot be verified",
      EXIT_RUNTIME
    );
  }
  return parsed;
}

/** `auth.broker.url` as a nested key or a flat literal key, non-empty only. */
function ompBrokerUrl(config: Record<string, unknown>): string | null {
  const flat = config["auth.broker.url"];
  if (typeof flat === "string" && flat.trim() !== "") return flat;
  const auth = config["auth"];
  if (isPlainObject(auth)) {
    const broker = auth["broker"];
    if (isPlainObject(broker)) {
      const url = broker["url"];
      if (typeof url === "string" && url.trim() !== "") return url;
    }
  }
  return null;
}

function rejectOmpProviderOverride(
  config: Record<string, unknown>,
  path: string,
  providerId: string,
  envName: string
): void {
  const providers = config["providers"];
  if (!isPlainObject(providers)) return;
  if (!Object.prototype.hasOwnProperty.call(providers, providerId)) return;
  throw new AgentError(
    `OMP ${basename(path)} defines provider '${providerId}' (${path}), which can ` +
      `override baseUrl/apiKey ahead of the injected ${envName}; remove that ` +
      "provider entry or run native `omp`.",
    EXIT_RUNTIME
  );
}

/**
 * Describe a setting that can move an Infisical-pinned session onto another
 * model/provider, or enable a background runtime that does so. Only explicit
 * opt-ins count: OMP's default `retry.modelFallback: true` with an empty
 * `retry.fallbackChains` is safe, and `modelRoles` alone only renames roles
 * (the launcher pins default/smol/slow/plan and the active model).
 */
function ompImplicitSwitchRisk(config: Record<string, unknown>): string | null {
  const retry = config["retry"];
  if (isPlainObject(retry)) {
    const chains = retry["fallbackChains"];
    if (isPlainObject(chains) && Object.keys(chains).length > 0) {
      return `retry.fallbackChains declares ${Object.keys(chains).length} fallback chain(s)`;
    }
  }
  const advisor = config["advisor"];
  if (isPlainObject(advisor) && advisor["enabled"] === true) {
    return "advisor.enabled is true";
  }
  const promotion = config["contextPromotion"];
  if (isPlainObject(promotion) && promotion["enabled"] === true) {
    return "contextPromotion.enabled is true";
  }
  return null;
}

/** Existing local OMP credential stores. XDG data relocates `agent.db` only
 * when the corresponding `omp` directory already exists. */
function ompAuthDbPaths(agentDir: string = ompAgentDir()): string[] {
  const paths = [join(agentDir, "agent.db")];
  // XDG relocation applies to the default agent dir only; a named profile's
  // agent.db lives at a fixed path under ~/.omp/profiles.
  if (agentDir === ompAgentDir()) {
    const xdgData = process.env.XDG_DATA_HOME;
    if (xdgData) {
      const base = join(xdgData, "omp");
      if (existsSync(base)) paths.push(join(base, "agent.db"));
    }
  }
  return paths;
}

/**
 * Reject config that can switch the pinned model/provider implicitly: retry
 * fallback chains (modelFallback is true by default, so a non-empty chain is
 * the switch), the Advisor runtime, and context promotion. An absent retry
 * block or `fallbackChains: {}` stays allowed. Legacy global settings.json is
 * included because OMP migrates it at startup, after this check would
 * otherwise have inspected the config files. Project config.yaml is
 * deliberately not checked: OMP reads it only under the global agent
 * directory; the project compatibility spelling is config.yml.
 *
 * This runs at plan time for EVERY omp route: agents.toml forbids implicit
 * model fallback on all routes, so it is a model-pinning boundary rather than
 * a credential-trust one (those checks stay require_infisical-only). On
 * require_infisical routes the cmdExec pre-spawn recheck runs it again
 * alongside guardOmpCredentialSource, so those routes get plan-time plus
 * immediately-before-spawn coverage.
 */
export function guardOmpImplicitSwitch(providerId: string, agentDir: string = ompAgentDir()): void {
  const switchConfigs: Array<{ path: string; label: string; format: "yaml" | "json" }> = [
    { path: join(agentDir, "config.yml"), label: "config.yml", format: "yaml" },
    { path: join(agentDir, "config.yaml"), label: "config.yaml", format: "yaml" },
    { path: join(agentDir, "settings.json"), label: "settings.json", format: "json" },
    { path: join(process.cwd(), ".omp", "config.yml"), label: ".omp/config.yml", format: "yaml" },
    {
      path: join(process.cwd(), ".omp", "settings.json"),
      label: ".omp/settings.json",
      format: "json",
    },
  ];
  for (const file of switchConfigs) {
    const config = readOmpMapping(file.path, file.label, file.format);
    if (config === null) continue;
    const risk = ompImplicitSwitchRisk(config);
    if (risk !== null) {
      throw new AgentError(
        `OMP ${file.label} (${file.path}) enables an implicit model switch for ` +
          `the '${providerId}' OMP route: ${risk}. Remove that setting or run ` +
          "native `omp`.",
        EXIT_RUNTIME
      );
    }
  }
}

/**
 * OMP credential ladder: runtime override > models.yml apiKey > stored OAuth >
 * stored login key > extension fallback > environment > other stored key.
 * For a `require_infisical` route the launcher's process-scoped env must be
 * authoritative, so refuse to start when OMP could resolve a profile/agent
 * dir, a dotenv override, an auth broker, a models.* provider override, or a
 * stored credential ahead of it. Nothing is edited or deleted and no secret
 * value is printed.
 *
 * Known residual risk: an extension can register a config fallback
 * (`keys.setConfig(..., { fallback: true })`) that this file-based guard does
 * not inspect, and internal helper roles the user configures (for example an
 * advisor or subagent role with its own model) are outside this guard. The
 * explicit `--smol/--slow/--plan` pinning on the route is the
 * defense-in-depth stop for those cases.
 */
export function guardOmpCredentialSource(
  providerId: string,
  envName: string,
  custom?: { agentDir: string; modelsPath: string; modelsSha256: string }
): void {
  const agentDir = custom?.agentDir ?? ompAgentDir();
  const dotenv = readOmpDotenvAssignments(agentDir);

  // A. Reject relocated config/agent dir and profiles.
  for (const key of OMP_REJECTED_ENV_KEYS) {
    if (key in process.env) {
      throw new AgentError(
        `OMP ${key} is defined in the ambient environment for the ` +
          `Infisical-backed '${envName}' route. Infisical-backed OMP routes ` +
          "require the default OMP profile/agent directory; unset it (or remove " +
          "the .env entry) or run native `omp`.",
        EXIT_RUNTIME
      );
    }
    for (const file of dotenv) {
      if (file.names.has(key)) {
        throw new AgentError(
          `OMP ${key} is assigned in ${file.path} for the Infisical-backed ` +
            `'${envName}' route. Infisical-backed OMP routes require the default ` +
            "OMP profile/agent directory; unset it (or remove the .env entry) or " +
            "run native `omp`.",
          EXIT_RUNTIME
        );
      }
    }
  }

  // A2. Reject a dotenv XDG_DATA_HOME: OMP would relocate `agent.db` there,
  // but ompAuthDbPaths() follows only the ambient process.env value, so the
  // stored-credential check below would inspect the wrong store and a stored
  // credential could outrank the Infisical key. An ambient (process.env)
  // XDG_DATA_HOME is already followed by ompAuthDbPaths and stays allowed.
  for (const file of dotenv) {
    if (file.names.has("XDG_DATA_HOME")) {
      throw new AgentError(
        `OMP XDG_DATA_HOME is assigned in ${file.path} for the Infisical-backed ` +
          `'${envName}' route: it would relocate agent.db away from the store the ` +
          "launcher verifies. Unset it (or remove the .env entry) or run native " +
          "`omp`.",
        EXIT_RUNTIME
      );
    }
  }

  // B. Reject an auth broker: it replaces the local store and resolves
  // credentials outside the injected env.
  if ("OMP_AUTH_BROKER_URL" in process.env) {
    throw new AgentError(
      `OMP_AUTH_BROKER_URL is defined in the ambient environment for the ` +
        `Infisical-backed '${envName}' route; remove the broker setting or run ` +
        "native `omp`.",
      EXIT_RUNTIME
    );
  }
  for (const file of dotenv) {
    if (file.names.has("OMP_AUTH_BROKER_URL")) {
      throw new AgentError(
        `OMP_AUTH_BROKER_URL is assigned in ${file.path} for the Infisical-backed ` +
          `'${envName}' route; remove the broker setting or run native \`omp\`.`,
        EXIT_RUNTIME
      );
    }
  }
  for (const name of ["config.yml", "config.yaml"]) {
    const path = join(agentDir, name);
    const config = readOmpMapping(path, name, "yaml");
    if (config === null) continue;
    if (ompBrokerUrl(config) !== null) {
      throw new AgentError(
        `OMP ${name} configures auth.broker.url (${path}) for the ` +
          `Infisical-backed '${envName}' route; remove the broker setting or run ` +
          "native `omp`.",
        EXIT_RUNTIME
      );
    }
  }

  // C. Reject local provider/model overrides. Both YAML spellings are checked
  // whenever present; the legacy JSON file is migrated by OMP only when no
  // YAML exists, but it can still take effect, so it is checked too.
  // An omp_custom route's managed models.yml is exempt from the override
  // rejection — it IS the provider definition — but only while it is still
  // byte-identical to what the launcher generated (sha256 pinned at plan
  // time, rechecked here before spawn).
  for (const name of ["models.yml", "models.yaml"]) {
    const path = join(agentDir, name);
    if (custom && name === "models.yml" && path === custom.modelsPath) {
      const actual = createHash("sha256")
        .update(readFileSync(path, "utf8"))
        .digest("hex");
      if (actual !== custom.modelsSha256) {
        throw new AgentError(
          `OMP managed models.yml (${path}) changed since planning; refusing ` +
            `to start the Infisical-backed '${envName}' route`,
          EXIT_RUNTIME
        );
      }
      continue;
    }
    const models = readOmpMapping(path, name, "yaml");
    if (models !== null) rejectOmpProviderOverride(models, path, providerId, envName);
  }
  const legacyPath = join(agentDir, "models.json");
  const legacy = readOmpMapping(legacyPath, "models.json", "json");
  if (legacy !== null) rejectOmpProviderOverride(legacy, legacyPath, providerId, envName);

  // D. Reject stored credentials for the provider: a stored OAuth/login/API
  // key outranks the injected environment variable.
  for (const dbPath of ompAuthDbPaths(agentDir)) {
    if (!existsSync(dbPath)) continue;
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const table = db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials' LIMIT 1"
        )
        .get();
      if (table) {
        // OMP ignores disabled credentials; only an active row outranks env.
        const row = db
          .query(
            "SELECT 1 FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL LIMIT 1"
          )
          .get(providerId);
        if (row) {
          throw new AgentError(
            `OMP has a stored '${providerId}' credential in ${dbPath} that ` +
              `outranks the injected ${envName}; remove or relocate it ` +
              `(\`omp logout ${providerId}\` or the relevant auth UI) or run ` +
              "native `omp`.",
            EXIT_RUNTIME
          );
        }
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      const detail = errorMessage(error);
      throw new AgentError(
        `cannot verify the OMP credential store (${dbPath}): ${detail}; refusing ` +
          "to start because the credential source cannot be verified",
        EXIT_RUNTIME
      );
    } finally {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  }
}