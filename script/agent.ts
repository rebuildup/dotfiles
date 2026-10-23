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
 * symlinked argv[1]. Native `claude`/`opencode`/`pi`/`dsh` are never
 * wrapped or overridden.
 */

import { basename, delimiter, dirname, join, resolve } from "node:path";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { normalizeCatalog, freeIneligibleReason, type CatalogModel } from "./agent-catalog";
import { parseHarnessVersion } from "./agent-harness-version";
import { assessQuality, loadQualityStore, rankQualified, type QualityAssessment, type QualityPolicy } from "./agent-quality";

const PROGRAM = "agent";
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 1;

const ADAPTERS = ["anthropic", "opencode", "pi", "passthrough"];

// argv-safe assign marker handled inside the child stage: only the model id
// crosses argv, the surrounding config is merged from the environment.
const MODEL_MARKER = "@@model:";
// argv-safe marker for "copy this secret from another env name"; kept
// distinct from a bare `@` so real model ids that start with `@`
// (e.g. Cloudflare's `@cf/...`) pass through as literal values.
const CRED_MARKER = "@@cred:";

const SHORTCUT_MODEL_FLAG = "--agent-model";
const IS_WINDOWS = process.platform === "win32";
const LAUNCHER_BASENAME = basename(import.meta.path);

const USAGE = `\
usage:
  agent <harness> <provider> [--model <id>] [-- <harness args>...]
  agent <harness> [-- <harness args>...]        # native: no provider, no injection
  <harness>-<provider> [<harness args>...]      # shortcut (agent shortcuts create)
  agent list
  agent models <provider>
  agent select <harness> <provider> [--model <id>] [--allow-unverified]
  agent evaluate --help
  agent evaluate calibrate <harness> --model <id> --reason <rationale>
  agent shortcuts [list|check|create|remove]
  agent check
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
  (Claude Code uses its subscription login, opencode/pi their own account).
  A leading flag or '--' passes harness arguments:
    agent claude -p "say ok"
    agent opencode -- run "explain this repo"
  --model / -m still require a provider route (exit 2); use plain
  \`<harness>\` when you want the harness's own model flags. A failing
  route never falls back to native mode.

run options:
  --allow-unverified         explicit experimental free model; requires --model
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
  agent claude deepseek -- -p "say ok"
  agent claude minimax -- -p "say ok"   # default MiniMax-M3.1-Flash (--model overrides)
  agent pi openrouter -- -p "hello"
  agent dsh deepseek -- web
  agent claude -p "say ok"              # native: subscription login, no injection
  agent dsh -- web                      # native dsh (args after '--')
  opencode-zen -- run "explain this repo"   # shortcut form
  claude                       # plain claude keeps official native auth

config: {config_path}
credentials: {with_secrets} (Infisical, process-scoped)
`;

class AgentError extends Error {
  code: number;
  constructor(message: string, code: number = EXIT_USAGE) {
    super(message);
    this.code = code;
  }
}

interface Provider {
  key: string;
  label: string;
  base_url: string | null;
  secret: string | null;
  env: string | null;
  default_model: string | null;
  require_model: boolean;
  models: string[];
  opencode_id: string;
  pi_id: string;
  // "openrouter": models are selected from the live public catalog (see
  // resolveCatalogModel); `models` then only orders preferences.
  catalog: string | null;
  min_context: number;
  quality_file: string | null;
  quality_policy: QualityPolicy;
  // extra child env for the anthropic adapter (non-secret tuning only)
  env_extra: Record<string, string>;
}

interface Harness {
  key: string;
  label: string;
  command: string;
  adapter: string;
  env: Record<string, string>;
}

interface Route {
  key: string;
  harness: string;
  provider: string;
  default_model: string | null;
  models: string[] | null;
  require_model: boolean;
  note: string;
}

interface Config {
  path: string;
  drop_env: string[];
  providers: Record<string, Provider>;
  harnesses: Record<string, Harness>;
  routes: Record<string, Route>;
}

interface Plan {
  command: string[];
  keep: Set<string>;
  copy: Array<[string, string]>;
  unset: string[];
  assign: Array<[string, string]>;
  // (env_name, secret_name) that must hold a credential before exec
  require_cred: Array<[string, string]>;
  drop: string[];
  baseline: string[] | null; // null = current process env
}

function repoRoot(): string {
  return dirname(dirname(realpathSync(import.meta.path)));
}

function configPath(): string {
  return process.env.AGENT_CONFIG || join(repoRoot(), "config", "agents.toml");
}

function withSecretsPath(): string {
  return (
    process.env.AGENT_WITH_SECRETS ||
    join(repoRoot(), "script", IS_WINDOWS ? "with-secrets.ps1" : "with-secrets")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Route keys are `<harness>.<provider>`; split at the first dot only.
 * (JS String.split's limit argument is not Python's maxsplit.) */
function splitRouteKey(key: string): [string, string] {
  const index = key.indexOf(".");
  return [key.slice(0, index), key.slice(index + 1)];
}

function requireStr(data: Record<string, unknown>, key: string, where: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value) {
    throw new AgentError(`${where}: missing or invalid string '${key}'`);
  }
  return value;
}

function optionalStr(data: Record<string, unknown>, key: string, where: string): string | null {
  const value = data[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new AgentError(`${where}: '${key}' must be a non-empty string`);
  }
  return value;
}

function stringList(value: unknown, where: string, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new AgentError(`${where}: '${key}' must be a list of non-empty strings`);
  }
  const list = value as string[];
  if (new Set(list).size !== list.length) {
    throw new AgentError(`${where}: '${key}' contains duplicate entries`);
  }
  return [...list];
}

function loadConfig(path?: string): Config {
  const configPathResolved = path || configPath();
  let text: string;
  try {
    text = readFileSync(configPathResolved, "utf8");
  } catch {
    throw new AgentError(`config not found: ${configPathResolved}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse<Record<string, unknown>>(text);
  } catch (exc) {
    throw new AgentError(`invalid TOML in ${configPathResolved}: ${exc}`);
  }

  const defaults = raw["defaults"] ?? {};
  if (!isPlainObject(defaults)) {
    throw new AgentError("defaults: table expected");
  }
  const drop_env = stringList(defaults["drop_env"] ?? [], "defaults", "drop_env");

  const providers: Record<string, Provider> = {};
  const rawProviders = raw["providers"] ?? {};
  if (!isPlainObject(rawProviders)) {
    throw new AgentError("providers: table expected");
  }
  for (const [key, tableValue] of Object.entries(rawProviders)) {
    const where = `providers.${key}`;
    if (!isPlainObject(tableValue)) {
      throw new AgentError(`${where}: table expected`);
    }
    const table = tableValue;
    const secret = optionalStr(table, "secret", where);
    const base_url = optionalStr(table, "base_url", where);
    const env = optionalStr(table, "env", where) || secret;
    const models = stringList(table["models"] ?? [], where, "models");
    const default_model = optionalStr(table, "default_model", where);
    const require_model = table["require_model"] ?? false;
    if (typeof require_model !== "boolean") {
      throw new AgentError(`${where}: 'require_model' must be a boolean`);
    }
    if (default_model && require_model) {
      throw new AgentError(
        `${where}: require_model = true contradicts default_model = '${default_model}'`
      );
    }
    if (default_model && models.length > 0 && !models.includes(default_model)) {
      throw new AgentError(
        `${where}: default_model '${default_model}' is not in models [${models.join(", ")}]`
      );
    }
    const catalog = optionalStr(table, "catalog", where);
    if (catalog !== null && catalog !== "openrouter") {
      throw new AgentError(`${where}: unknown catalog '${catalog}' (expected "openrouter")`);
    }
    if (catalog && (default_model || require_model)) {
      throw new AgentError(`${where}: catalog providers select their model live; drop default_model/require_model`);
    }
    if (catalog && !base_url) {
      throw new AgentError(`${where}: catalog = "openrouter" needs base_url`);
    }
    const rawExtra = table["env_extra"] ?? {};
    if (!isPlainObject(rawExtra) || Object.values(rawExtra).some((v) => typeof v !== "string")) {
      throw new AgentError(`${where}: env_extra must map string -> string`);
    }
    const env_extra = rawExtra as Record<string, string>;
    const min_context = table["min_context"] ?? 128000;
    if (typeof min_context !== "number" || !Number.isInteger(min_context) || min_context < 0) {
      throw new AgentError(`${where}: 'min_context' must be a non-negative integer`);
    }
    const quality = table["quality"] ?? {};
    if (!isPlainObject(quality)) throw new AgentError(`${where}: quality must be a table`);
    const version = quality["evaluation_version"] ?? "agent-e2e-v1";
    const minTrials = quality["min_trials"] ?? 3;
    const maxAgeDays = quality["max_age_days"] ?? 14;
    if (typeof version !== "string" || !version || typeof minTrials !== "number" || !Number.isSafeInteger(minTrials) || minTrials < 3 ||
        typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 14) {
      throw new AgentError(`${where}: quality requires evaluation_version, min_trials >= 3 and 0 < max_age_days <= 14`);
    }
    providers[key] = {
      key,
      label: requireStr(table, "label", where),
      base_url,
      secret,
      env,
      default_model,
      require_model,
      models,
      opencode_id: optionalStr(table, "opencode_id", where) || key,
      pi_id: optionalStr(table, "pi_id", where) || key,
      catalog,
      min_context,
      quality_file: optionalStr(table, "quality_file", where),
      quality_policy: { evaluationVersion: version, minCapabilityTrials: minTrials, maxAgeDays },
      env_extra,
    };
  }
  if (Object.keys(providers).length === 0) {
    throw new AgentError("config declares no providers");
  }

  const harnesses: Record<string, Harness> = {};
  const rawHarnesses = raw["harnesses"] ?? {};
  if (!isPlainObject(rawHarnesses)) {
    throw new AgentError("harnesses: table expected");
  }
  for (const [key, tableValue] of Object.entries(rawHarnesses)) {
    const where = `harnesses.${key}`;
    if (!isPlainObject(tableValue)) {
      throw new AgentError(`${where}: table expected`);
    }
    const table = tableValue;
    const adapter = requireStr(table, "adapter", where);
    if (!ADAPTERS.includes(adapter)) {
      throw new AgentError(
        `${where}: unknown adapter '${adapter}' (expected one of ${ADAPTERS.join(", ")})`
      );
    }
    const envTable = table["env"] ?? {};
    if (!isPlainObject(envTable) || Object.values(envTable).some((v) => typeof v !== "string")) {
      throw new AgentError(`${where}: env must map string -> string (names only)`);
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(envTable)) {
      env[name] = value as string;
    }
    if (adapter === "anthropic") {
      const required = [
        "base_url",
        "auth_token",
        "api_key",
        "model",
        "small_fast_model",
        "default_opus",
        "default_sonnet",
        "default_haiku",
      ];
      const missing = required.filter((name) => !(name in env));
      if (missing.length > 0) {
        throw new AgentError(`${where}: adapter anthropic requires env names [${missing.join(", ")}]`);
      }
    }
    if (adapter === "opencode" && !("config_content" in env)) {
      throw new AgentError(`${where}: adapter opencode requires env name 'config_content'`);
    }
    harnesses[key] = {
      key,
      label: requireStr(table, "label", where),
      command: requireStr(table, "command", where),
      adapter,
      env,
    };
  }
  if (Object.keys(harnesses).length === 0) {
    throw new AgentError("config declares no harnesses");
  }

  const routes: Record<string, Route> = {};
  const rawRoutes = raw["routes"] ?? {};
  if (!isPlainObject(rawRoutes)) {
    throw new AgentError("routes: table expected");
  }
  for (const [key, tableValue] of Object.entries(rawRoutes)) {
    const where = `routes.'${key}'`;
    if (!isPlainObject(tableValue)) {
      throw new AgentError(`${where}: table expected`);
    }
    const table = tableValue;
    if (!key.includes(".")) {
      throw new AgentError(`${where}: key must be '<harness>.<provider>'`);
    }
    const [harness_key, provider_key] = splitRouteKey(key);
    if (!(harness_key in harnesses)) {
      throw new AgentError(`${where}: unknown harness '${harness_key}'`);
    }
    if (!(provider_key in providers)) {
      throw new AgentError(`${where}: unknown provider '${provider_key}'`);
    }
    let route_models: string[] | null = null;
    if (table["models"] !== undefined && table["models"] !== null) {
      route_models = stringList(table["models"], where, "models");
    }
    const require_model = table["require_model"] ?? false;
    if (typeof require_model !== "boolean") {
      throw new AgentError(`${where}: 'require_model' must be a boolean`);
    }
    const route: Route = {
      key,
      harness: harness_key,
      provider: provider_key,
      default_model: optionalStr(table, "default_model", where),
      models: route_models,
      require_model,
      note: optionalStr(table, "note", where) || "",
    };
    validateRouteDefaults(route, providers[provider_key]);
    routes[key] = route;
  }
  if (Object.keys(routes).length === 0) {
    throw new AgentError("config declares no routes");
  }

  // Every claude-anthropic route needs an Anthropic-compatible endpoint.
  for (const route of Object.values(routes)) {
    const harness = harnesses[route.harness];
    const provider = providers[route.provider];
    if (harness.adapter === "anthropic" && !provider.base_url) {
      throw new AgentError(
        `routes.${route.key}: adapter anthropic needs provider '${provider.key}' to declare base_url`
      );
    }
  }

  // Shortcut names must be unambiguous: `harness-provider` is derived from
  // the route key, and two different routes must never map to one name.
  const seen: Record<string, string> = {};
  for (const key of Object.keys(routes)) {
    const [harness_key, provider_key] = splitRouteKey(key);
    const name = shortcutName(harness_key, provider_key);
    if (name in seen) {
      throw new AgentError(
        `routes.${key}: shortcut name '${name}' collides with route ${seen[name]}; ` +
          "rename the harness or provider key"
      );
    }
    seen[name] = key;
  }

  return { path: configPathResolved, drop_env, providers, harnesses, routes };
}

function effectiveModels(route: Route, provider: Provider): string[] {
  return route.models ?? provider.models;
}

function routeRequiresModel(route: Route, provider: Provider): boolean {
  return route.require_model || provider.require_model;
}

function routeDefaultModel(route: Route, provider: Provider): string | null {
  return route.default_model || provider.default_model;
}

function validateRouteDefaults(route: Route, provider: Provider): void {
  const where = `routes.'${route.key}'`;
  if (provider.catalog) {
    if (route.default_model || route.require_model || route.models) {
      throw new AgentError(`${where}: catalog provider '${provider.key}' selects models live; drop route model settings`);
    }
    return;
  }
  const defaultModel = routeDefaultModel(route, provider);
  const models = effectiveModels(route, provider);
  if (routeRequiresModel(route, provider)) {
    if (defaultModel) {
      throw new AgentError(
        `${where}: require_model = true but a default model '${defaultModel}' exists`
      );
    }
    if (models.length === 0) {
      throw new AgentError(
        `${where}: require_model = true needs a models list to validate --model`
      );
    }
    return;
  }
  if (!defaultModel) {
    throw new AgentError(
      `${where}: no default model and require_model is not set; ` +
        "declare route.default_model, provider.default_model or require_model = true"
    );
  }
  if (models.length > 0 && !models.includes(defaultModel)) {
    throw new AgentError(
      `${where}: default model '${defaultModel}' is not in models [${models.join(", ")}]`
    );
  }
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
// Live free-model catalog (OpenRouter). Selection happens once, at launch:
// the harnesses fix the model for the whole session and the launcher is not
// a proxy. Mid-session failover is unsupported; restart rechecks both gates.
// The random free router cannot identify a qualified model. Nothing can select a
// priced model: eligibility requires every pricing field to be exactly 0.
// ---------------------------------------------------------------------------

const FREE_ROUTER_ID = "openrouter/free";
const CATALOG_TTL_MS = 60 * 60 * 1000; // re-fetch at most hourly
const CATALOG_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // usable when the fetch fails
const EXPIRY_DEPRIORITIZE_MS = 14 * 24 * 60 * 60 * 1000; // ranked last, still selectable

interface Catalog {
  fetched_at: number;
  models: CatalogModel[];
  source: "live" | "cache" | "stale";
}

function cacheDir(): string {
  const base =
    process.env.AGENT_CACHE_DIR ||
    (IS_WINDOWS
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  return process.env.AGENT_CACHE_DIR ? base : join(base, "dotfiles-agent");
}

function catalogUrl(provider: Provider): string {
  return process.env.AGENT_CATALOG_URL || `${(provider.base_url ?? "").replace(/\/+$/, "")}/v1/models`;
}

function readCatalogCache(file: string): { fetched_at: number; models: CatalogModel[] } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isPlainObject(parsed) || typeof parsed["fetched_at"] !== "number" || !Number.isFinite(parsed["fetched_at"]) || parsed["fetched_at"] > Date.now() || parsed["fetched_at"] < 0) return null;
    return { fetched_at: parsed["fetched_at"], models: normalizeCatalog(parsed["models"]) };
  } catch {
    return null;
  }
}

async function loadCatalog(provider: Provider, forceRefresh: boolean): Promise<Catalog> {
  const file = join(cacheDir(), `${provider.key}-models.json`);
  const now = Date.now();
  const cached = readCatalogCache(file);
  if (cached && !forceRefresh && now - cached.fetched_at < CATALOG_TTL_MS) {
    return { ...cached, source: "cache" };
  }
  let failure: string;
  try {
    // The catalog is public: no credential is sent.
    const response = await fetch(catalogUrl(provider), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    const models = normalizeCatalog(isPlainObject(body) ? body["data"] : undefined);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetched_at: now, models }));
      renameSync(tmp, file);
    } catch (exc) {
      console.error(`${PROGRAM}: warning: cannot write model cache ${file}: ${exc}`);
    }
    return { fetched_at: now, models, source: "live" };
  } catch (exc) {
    failure = exc instanceof Error ? exc.message : String(exc);
  }
  if (cached && now - cached.fetched_at < CATALOG_STALE_MAX_MS) {
    const hours = Math.round((now - cached.fetched_at) / 3_600_000);
    console.error(
      `${PROGRAM}: warning: model catalog fetch failed (${failure}); using cache from ${hours}h ago`
    );
    return { ...cached, source: "stale" };
  }
  throw new AgentError(
    `cannot determine available free models: catalog fetch failed (${failure}) and no usable cache ` +
      `(${file}). No model is guessed and no paid fallback is used.`,
    EXIT_RUNTIME
  );
}

/** Availability discovery order. Quality evidence determines actual selection. */
function rankFreeModels(catalog: Catalog, provider: Provider, now: number): CatalogModel[] {
  const tier = (m: CatalogModel): number => {
    const expires = m.expiration_date ? Date.parse(m.expiration_date) : NaN;
    return Number.isFinite(expires) && expires - now < EXPIRY_DEPRIORITIZE_MS ? 1 : 0;
  };
  const preference = (m: CatalogModel): number => {
    const index = provider.models.indexOf(m.id);
    return index === -1 ? provider.models.length : index;
  };
  return catalog.models
    .filter((m) => m.id !== FREE_ROUTER_ID && freeIneligibleReason(m, provider, now) === null)
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        preference(a) - preference(b) ||
        b.context_length - a.context_length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

function qualityPath(provider: Provider): string {
  return process.env.AGENT_QUALITY_FILE ||
    (provider.quality_file ? resolve(dirname(configPath()), provider.quality_file) : join(cacheDir(), `${provider.key}-quality.json`));
}

function versionEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  return env;
}

async function qualityAssessments(provider: Provider, harness: Harness, models: CatalogModel[], evidencePath = qualityPath(provider)): Promise<QualityAssessment[]> {
  try {
    const store = await loadQualityStore(evidencePath);
    const { evaluationFixtureDigest } = await import("./agent-eval-fixture");
    const command = which(harness.command);
    if (!command) throw new Error(`harness not found: ${harness.command}`);
    const versionEnv = versionEnvironment();
    const version = Bun.spawnSync(launchArgv(command, ["--version"], versionEnv), {
      env: versionEnv, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const harnessVersion = parseHarnessVersion(version.stdout.toString(), version.stderr.toString());
    if (version.exitCode !== 0 || !harnessVersion) throw new Error("cannot determine current harness version");
    return models.map(m => assessQuality(store, m.id, harness.key, new Date(), {
      ...provider.quality_policy, fixtureDigest: evaluationFixtureDigest(), harnessVersion,
    }));
  } catch (error) {
    return models.map(m => ({ model_id: m.id, harness: harness.key, status: "unverified", metrics: null,
      reasons: [error instanceof Error ? error.message : "Cannot read quality evidence"] }));
  }
}

async function resolveCatalogModel(
  route: Route,
  provider: Provider,
  cliModel: string | null,
  allowUnverified = false,
  forceRefresh = false,
  harness?: Harness,
): Promise<string> {
  if (allowUnverified && !cliModel) throw new AgentError("--allow-unverified requires an explicit --model");
  if (!cliModel && process.env.AGENT_MODEL) console.error("agent: warning: AGENT_MODEL is no longer read; use --model");
  const catalog = await loadCatalog(provider, forceRefresh);
  if (catalog.source === "stale") throw new AgentError("stale catalog is discovery-only; cannot authorize current free pricing. Retry after the official catalog recovers.", EXIT_RUNTIME);
  const now = Date.now();
  const available = rankFreeModels(catalog, provider, now);
  const top = available.slice(0, 5).map(m => m.id).join("\n  ");
  if (cliModel) {
    const entry = catalog.models.find(m => m.id === cliModel);
    const reason = entry ? freeIneligibleReason(entry, provider, now) : "not in the live OpenRouter catalog (retired or unknown)";
    if (reason) throw new AgentError(`model '${cliModel}' cannot be used on route '${route.key}': ${reason}.\nCurrently available free models:\n  ${top || "(none)"}`);
    if (allowUnverified) {
      console.error(`${PROGRAM}: ${provider.key} -> ${cliModel} (explicit --allow-unverified; quality is not guaranteed)`);
      return cliModel;
    }
  }
  if (!available.length) throw new AgentError(`no eligible free model for route '${route.key}'; stopping without a paid fallback`, EXIT_RUNTIME);
  if (!harness) throw new AgentError("quality selection requires a harness", EXIT_RUNTIME);
  const assessments = await qualityAssessments(provider, harness, available);
  const qualified = rankQualified(assessments);
  if (cliModel) {
    const assessment = assessments.find(a => a.model_id === cliModel)!;
    if (assessment.status !== "qualified") throw new AgentError(`model '${cliModel}' is ${assessment.status} for ${route.harness}: ${assessment.reasons.join("; ")}. Explicit experimental use requires --allow-unverified with --model.`);
    console.error(`${PROGRAM}: ${provider.key} -> ${cliModel} (${assessment.reasons.join("; ")})`);
    return cliModel;
  }
  const chosen = qualified[0];
  if (!chosen) throw new AgentError(`no qualified free model for route '${route.key}'. No unverified or paid fallback.\n` + assessments.map(a => `  ${a.model_id}: ${a.status}: ${a.reasons.join("; ")}`).join("\n") + `\nRun 'agent models ${provider.key}' or 'agent evaluate --help'.`, EXIT_RUNTIME);
  console.error(`${PROGRAM}: ${provider.key} -> ${chosen.model_id} (${chosen.reasons.join("; ")}; completion reliability first, tool reliability then duration)`);
  return chosen.model_id;
}

// ---------------------------------------------------------------------------
// Shortcut form: `<harness>-<provider>` invoked directly (symlink to this
// script on Unix, generated .cmd on Windows). The name is resolved by exact
// match against the configured routes, never by splitting on hyphens.
// ---------------------------------------------------------------------------

function shortcutName(harnessKey: string, providerKey: string): string {
  return `${harnessKey}-${providerKey}`;
}

function shortcutMap(config: Config): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const key of Object.keys(config.routes)) {
    const [harness_key, provider_key] = splitRouteKey(key);
    mapping[shortcutName(harness_key, provider_key)] = key;
  }
  return mapping;
}

function resolveShortcut(config: Config, name: string): [string, string] {
  const routeKey = shortcutMap(config)[name];
  if (!routeKey) {
    const known = Object.keys(shortcutMap(config)).sort().join(", ");
    throw new AgentError(
      `unknown shortcut '${name}'; shortcuts exist for these routes: ${known}\n` +
        "Define the route in config/agents.toml and run 'agent shortcuts create' to link it."
    );
  }
  const [harnessKey, providerKey] = splitRouteKey(routeKey);
  return [harnessKey, providerKey];
}

function parseShortcutArgs(argv: string[]): { model: string | null; passthru: string[]; allowUnverified: boolean } {
  // Shortcut argv: --agent-model and --allow-unverified are launcher-owned, the rest is the
  // harness's own argument vector (passed verbatim, no '--' required).
  let model: string | null = null;
  let allowUnverified = false;
  const passthru: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") { passthru.push(...argv.slice(index + 1)); break; }
    if (token === "--allow-unverified") { allowUnverified = true; index++; continue; }
    if (token === SHORTCUT_MODEL_FLAG) {
      if (index + 1 >= argv.length) {
        throw new AgentError(`${token} requires a value`);
      }
      model = argv[index + 1];
      index += 2;
      continue;
    }
    if (token.startsWith(`${SHORTCUT_MODEL_FLAG}=`)) {
      const value = token.slice(SHORTCUT_MODEL_FLAG.length + 1);
      if (!value) {
        throw new AgentError(`'${token}' requires a value`);
      }
      model = value;
      index += 1;
      continue;
    }
    passthru.push(token);
    index += 1;
  }
  if (passthru.length > 0 && passthru[0] === "--") {
    // tolerated so `opencode-zen -- run …` matches the agent-form habit
    passthru.shift();
  }
  return { model, passthru, allowUnverified };
}

/**
 * Recover the script path this process was invoked as. Bun resolves the
 * symlinked argv[1] to the real file, so the kernel-level argv is consulted
 * instead: /proc/self/cmdline on Linux (WSL included), `ps` on macOS.
 */
function invokedScriptPath(): string | null {
  const a1 = process.argv[1];
  if (a1) {
    const base = basename(a1);
    if (base !== LAUNCHER_BASENAME && base !== "bun") {
      return a1; // invoked as another file (or an unresolved symlink)
    }
  }
  let kernelArgv: string[] | null = null;
  if (process.platform === "linux") {
    try {
      kernelArgv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
    } catch {
      kernelArgv = null;
    }
  } else if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "args="]);
      if (result.exitCode === 0) {
        kernelArgv = result.stdout.toString().trim().split(/\s+/).filter(Boolean);
      }
    } catch {
      kernelArgv = null;
    }
  }
  const token = kernelArgv && kernelArgv.length > 1 ? kernelArgv[1] : null;
  if (token && basename(token) !== LAUNCHER_BASENAME && basename(token) !== "bun") {
    return token;
  }
  return null;
}

function binDir(): string {
  if (process.env.AGENT_BIN_DIR) return process.env.AGENT_BIN_DIR;
  return join(homedir(), ".local", "bin");
}

function launcherLinkTarget(): string {
  return realpathSync(import.meta.path);
}

function shortcutPath(name: string): string {
  const ext = IS_WINDOWS ? ".cmd" : "";
  return join(binDir(), `${name}${ext}`);
}

function which(cmd: string, pathEnv?: string): string | null {
  const hasSeparator = cmd.includes("/") || (IS_WINDOWS && cmd.includes("\\"));
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (hasSeparator) {
    return isExecutable(cmd) ? cmd : null;
  }
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  // Windows: PATHEXT candidates BEFORE the bare name. npm generates an
  // extensionless Bash-style shim next to `opencode.cmd` for Cygwin-style
  // shells; that file is not a Windows executable, so trying the bare name
  // first would pick an unrunnable target.
  const exts = IS_WINDOWS
    ? [...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
    : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const base = join(dir, cmd);
    for (const suffix of exts) {
      const candidate = base + suffix;
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

const WINDOWS_CMD_MARKER = "rem managed-by: agent-launcher";

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

function shortcutLinkTargetContent(target: string, name: string): string {
  // Minimal Windows entry point generated from the routes; the name is the
  // only thing in argv, everything else stays in script/agent.ts.
  return `@echo off\r\n${WINDOWS_CMD_MARKER} ${target}\r\nbun "${target}" ${name} %*\r\n`;
}

function linkStatus(name: string, target: string): string {
  const path = shortcutPath(name);
  if (IS_WINDOWS) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      return content.includes(`${WINDOWS_CMD_MARKER} ${target}`) ? "linked" : "conflict (existing file)";
    }
    return which(name) ? `conflict (command exists at ${which(name)})` : "missing";
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      // realpathSync throws for a dangling link (e.g. after the checkout
      // moved); treat it as a conflict so `create` never tries EEXIST and
      // the user gets an actionable message instead of "missing".
      try {
        return realpathSync(path) === target ? "linked" : "conflict (foreign symlink)";
      } catch {
        return "conflict (dangling symlink)";
      }
    }
    return "conflict (existing file)";
  } catch {
    return which(name) ? `conflict (command exists at ${which(name)})` : "missing";
  }
}

function cmdShortcuts(config: Config, action: string | null): number {
  const target = launcherLinkTarget();
  const names = Object.keys(shortcutMap(config)).sort();
  const where = binDir();

  if (action === null || action === "list") {
    console.log(`shortcut commands (from ${config.path}):`);
    for (const name of names) {
      console.log(`  ${name.padEnd(24)} ${linkStatus(name, target)}`);
    }
    console.log(`location: ${where}   target: ${target}`);
    console.log("create/remove with: agent shortcuts create | remove");
    return 0;
  }

  if (action === "check") {
    const bad = names.filter((name) => linkStatus(name, target) !== "linked");
    if (bad.length > 0) {
      console.error(
        `shortcuts not ready: ${bad.join(", ")}\n` +
          `run 'agent shortcuts create' (location: ${where})`
      );
      return EXIT_RUNTIME;
    }
    console.log(`shortcuts OK: ${names.length} links in ${where} point at ${target}`);
    return 0;
  }

  if (action === "create") {
    const conflicts: string[] = [];
    for (const name of names) {
      const status = linkStatus(name, target);
      if (status === "linked") continue;
      if (status.startsWith("conflict")) {
        conflicts.push(`${shortcutPath(name)}: ${status}`);
      }
    }
    if (conflicts.length > 0) {
      throw new AgentError(
        `refusing to overwrite:\n  ${conflicts.join("\n  ")}\n` +
          "remove or rename these entries, then re-run 'agent shortcuts create'",
        EXIT_RUNTIME
      );
    }
    mkdirSync(where, { recursive: true });
    let created = 0;
    let linked = 0;
    for (const name of names) {
      const path = shortcutPath(name);
      if (existsSync(path)) {
        linked += 1;
        continue;
      }
      if (IS_WINDOWS) {
        writeFileSync(path, shortcutLinkTargetContent(target, name));
      } else {
        symlinkSync(target, path);
      }
      created += 1;
    }
    console.log(`shortcuts ready: ${created} created, ${linked} already linked in ${where}`);
    return 0;
  }

  if (action === "remove") {
    let removed = 0;
    for (const name of names) {
      const path = shortcutPath(name);
      if (IS_WINDOWS) {
        if (existsSync(path) && readFileSync(path, "utf8").includes(`${WINDOWS_CMD_MARKER} ${target}`)) {
          unlinkSync(path);
          removed += 1;
        } else if (existsSync(path)) {
          console.log(`left untouched (not managed by the launcher): ${path}`);
        }
        continue;
      }
      try {
        const stat = lstatSync(path);
        if (!stat.isSymbolicLink()) {
          console.log(`left untouched (not managed by the launcher): ${path}`);
          continue;
        }
        let pointsHere = false;
        try {
          pointsHere = realpathSync(path) === target;
        } catch {
          // dangling: the target cannot be verified, so it is not provably
          // ours — keep it and tell the user instead of silently skipping.
          console.log(`left untouched (dangling symlink): ${path}`);
          continue;
        }
        if (pointsHere) {
          unlinkSync(path);
          removed += 1;
        } else {
          console.log(`left untouched (not managed by the launcher): ${path}`);
        }
      } catch {
        // nothing to remove
      }
    }
    console.log(`shortcuts removed: ${removed}`);
    return 0;
  }

  throw new AgentError(
    `unknown shortcuts action '${action}'; use list, check, create or remove`
  );
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

function checkPassthru(passthru: string[], harness: Harness): void {
  for (const token of passthru) {
    // Match `--flag` and `--flag=value` forms alike so an inline value
    // cannot smuggle a forbidden selector past this filter.
    const flag = token.startsWith("-") ? token.split("=", 1)[0] : token;
    const reason = FORBIDDEN_PASSTHRU[flag];
    if (reason) {
      throw new AgentError(
        `harness argument '${token}' is not allowed for adapter '${harness.adapter}': ${reason}`
      );
    }
  }
}

type Action =
  | ["help"]
  | ["version"]
  | ["list"]
  | ["check"]
  | ["models", string]
  | ["shortcuts", string | null]
  | ["native", string, string[]]
  | ["run", string, string, string | null, string[], boolean];

function parseArgs(argv: string[]): Action {
  // Parse argv without touching the config.
  const head = argv[0];
  if (head === "help" || head === "--help" || head === "-h") {
    if (argv.length > 1) {
      throw new AgentError(`unexpected arguments for 'help': ${argv.slice(1).join(" ")}`);
    }
    return ["help"];
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

  const harnessKey = head;
  if (argv.length < 2) {
    // Provider omitted: native mode — run the harness untouched (no
    // endpoint/model/credential injection; its own subscription/account).
    return ["native", harnessKey, []];
  }
  if (argv[1] === "--help" || argv[1] === "-h" || argv[1] === "help") {
    return ["help"];
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
  let allowUnverified = false;
  let passthru: string[] = [];
  const rest = argv.slice(2);
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === "--allow-unverified") { allowUnverified = true; index++; continue; }
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
      return ["help"];
    }
    throw new AgentError(
      `unexpected argument '${token}'; pass harness arguments after '--' ` +
        `(e.g. agent ${harnessKey} ${providerKey} -- <args>)`
    );
  }
  return ["run", harnessKey, providerKey, model, passthru, allowUnverified];
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
  if (provider.secret || provider.env) {
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
    drop: [...new Set([...config.drop_env, ...providerCreds])].sort(),
    baseline: null,
  };

  if (harness.adapter === "anthropic") {
    planAnthropic(plan, harness, provider, route, model);
  } else if (harness.adapter === "opencode") {
    planOpencode(plan, harness, provider, model);
  } else if (harness.adapter === "pi") {
    planPi(plan, harness, provider, model);
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
    [env["default_haiku"], model],
    ...Object.entries(provider.env_extra)
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

function planPi(plan: Plan, harness: Harness, provider: Provider, model: string | null): void {
  if (model === null) {
    throw new AgentError("resolved no model for adapter pi");
  }
  plan.command = [harness.command, "--provider", provider.pi_id, "--model", model, ...plan.command.slice(1)];
}

// ---------------------------------------------------------------------------
// Execution (child process with inherited stdio; no execve in Bun)
// ---------------------------------------------------------------------------

const SIGNAL_NUMBERS: Record<string, number> = osConstants.signals as unknown as Record<
  string,
  number
>;

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
  payload.push("--", ...plan.command);

  if (IS_WINDOWS && wrapper.endsWith(".ps1")) {
    const shell = which("pwsh") ? "pwsh" : "powershell";
    return runInherited(
      [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...payload],
      process.env
    );
  }
  return runInherited([wrapper, ...payload], process.env);
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
      const raw = env[name];
      let content: Record<string, unknown> = {};
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          console.error(`agent: warning: existing ${name} is not valid JSON; replacing it`);
          parsed = undefined;
        }
        if (isPlainObject(parsed)) {
          content = parsed;
        } else if (parsed !== undefined) {
          console.error(`agent: warning: existing ${name} is not an object; replacing it`);
        }
      }
      content["model"] = modelId;
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
  passthru: string[],
  allowUnverified = false,
  selectOnly = false,
): Promise<number> {
  const [harness, provider, route] = selectRoute(config, harnessKey, providerKey);
  if (allowUnverified && (!provider.catalog || !cliModel)) throw new AgentError("--allow-unverified requires an explicit model on a catalog route");
  if (provider.catalog && harness.adapter === "opencode") {
    const externalServer = passthru.some(token => ["--server", "--attach"].includes(token.split("=", 1)[0])) ||
      ["attach", "serve", "service", "api", "acp", "pair"].includes(passthru[0] ?? "");
    if (externalServer) throw new AgentError("free model selection requires a process-scoped OpenCode server; server/attach/service modes cannot preserve the selected model");
  }
  let model: string | null;
  if (harness.adapter === "passthrough") {
    if (cliModel !== null) {
      throw new AgentError(
        `harness '${harnessKey}' (adapter passthrough) does not accept --model via ${PROGRAM}; ` +
          "select the model inside the harness"
      );
    }
    model = null;
  } else if (provider.catalog) {
    model = await resolveCatalogModel(route, provider, cliModel, allowUnverified, false, harness);
  } else {
    model = resolveModel(route, provider, cliModel);
  }
  if (selectOnly) { console.log(model ?? "(harness-native)"); return 0; }
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
  const { model, passthru, allowUnverified } = parseShortcutArgs(argv);
  return cmdRun(config, harnessKey, providerKey, model, passthru, allowUnverified);
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
    const cell = provider.catalog ? "(availability + quality)" : (defaultModel ?? "--model required");
    let notes = route.note || "";
    if (defaultModel === null && !provider.catalog) {
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

async function cmdModels(config: Config, providerKey: string): Promise<number> {
  const provider = config.providers[providerKey];
  if (!provider) {
    const known = Object.keys(config.providers).sort().join(", ");
    throw new AgentError(`unknown provider '${providerKey}'; known providers: ${known}`);
  }
  console.log(`provider: ${provider.key} (${provider.label})`);
  if (provider.base_url) {
    console.log(`anthropic endpoint: ${provider.base_url}`);
  }
  if (provider.secret) {
    console.log(`credential: Infisical secret ${provider.secret} -> env ${provider.env}`);
  } else {
    console.log("credential: harness-native login (no Infisical secret)");
  }
  if (provider.models.length > 0) {
    console.log(`opencode model id example: ${provider.opencode_id}/${provider.models[0]}`);
  } else {
    console.log(`opencode model id format: ${provider.opencode_id}/<model>`);
  }
  console.log(`pi provider id: ${provider.pi_id}`);
  const routes = Object.values(config.routes)
    .filter((r) => r.provider === providerKey)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  console.log("routes:");
  for (const route of routes) {
    const harness = config.harnesses[route.harness];
    const defaultModel = routeDefaultModel(route, provider);
    const suffix = provider.catalog
      ? " (model selected live)"
      : defaultModel
        ? ` (default ${defaultModel})`
        : " (--model required)";
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
  if (provider.catalog) {
    // explicit, user-initiated command: always refreshes the cache
    const catalog = await loadCatalog(provider, true);
    const now = Date.now();
    const candidates = catalog.models.filter(m => m.id.endsWith(":free") || provider.models.includes(m.id));
    const available = rankFreeModels(catalog, provider, now);
    console.log(`free model discovery (catalog ${catalog.source}, min context ${provider.min_context}):`);
    console.log(
      `quality evidence: ${qualityPath(provider)}; public benchmark context: config/openrouter-benchmarks.json`,
    );
    for (const route of routes) {
      const assessments = await qualityAssessments(provider, config.harnesses[route.harness], available);
      const chosen = rankQualified(assessments)[0];
      console.log(`  ${route.harness}: selected ${catalog.source === "stale" ? "(none; stale catalog)" : chosen?.model_id ?? "(none qualified)"}`);
      for (const m of candidates) {
        const reason = freeIneligibleReason(m, provider, now);
        const quality = assessments.find(a => a.model_id === m.id);
        const metrics = quality?.metrics;
        const measured = metrics
          ? ` [completed ${metrics.successes}/${metrics.capability_trials}; tool failures ${metrics.tool_failures}/${metrics.tool_calls}; mean ${Math.round(metrics.duration_ms)}ms; infrastructure failures ${metrics.infrastructure_failures}]`
          : "";
        console.log(`    ${m.id}: ${reason ? "unavailable: " + reason : quality!.status + ": " + quality!.reasons.join("; ")}${measured}`);
      }
      for (const missing of provider.models.filter(id => !catalog.models.some(m => m.id === id))) console.log(`    ${missing}: unavailable: absent from catalog`);
    }
    return 0;
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

async function cmdCalibrate(config: Config, args: string[]): Promise<number> {
  if (args.length !== 5 || args[1] !== "--model" || args[3] !== "--reason" || !args[4].trim()) {
    throw new AgentError("usage: agent evaluate calibrate <harness> --model <id> --reason <measured selection rationale>");
  }
  const [harness, provider, route] = selectRoute(config, args[0], "openrouter-free");
  await resolveCatalogModel(route, provider, args[2], true, false, harness);
  const file = qualityPath(provider);
  const lock = `${file}.lock`;
  try { writeFileSync(lock, "calibration", { flag: "wx", mode: 0o600 }); }
  catch { throw new AgentError("quality evidence is locked by another evaluation/calibration", EXIT_RUNTIME); }
  try {
    const store = await loadQualityStore(file);
    const evaluation = store.evaluations.filter(e => e.model_id === args[2] && e.harness === harness.key)
      .sort((a, b) => Date.parse(b.evaluated_at) - Date.parse(a.evaluated_at))[0];
    if (!evaluation) throw new AgentError("no actual evaluation exists for this model and harness", EXIT_RUNTIME);
    store.calibration = {
      calibrated_at: new Date().toISOString(), rationale: args[4],
      baselines: [...(store.calibration?.baselines ?? []).filter(ref => ref.harness !== harness.key),
        { model_id: args[2], harness: harness.key, evaluated_at: evaluation.evaluated_at }],
    };
    // Use the same current-artifact policy as normal admission before persisting.
    const temporary = `${file}.${process.pid}.calibrating`;
    writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    try {
      const [assessment] = await qualityAssessments(provider, harness, [{ id: args[2] } as CatalogModel], temporary);
      if (assessment.status !== "qualified") throw new AgentError(`baseline cannot calibrate quality: ${assessment.reasons.join("; ")}`, EXIT_RUNTIME);
      renameSync(temporary, file);
      console.log(`${harness.key}: baseline ${args[2]} — ${assessment.reasons.join("; ")}`);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return 0;
  } finally { unlinkSync(lock); }
}

function cmdCheck(config: Config): number {
  console.log(
    `config OK: ${config.path} ` +
      `(${Object.keys(config.providers).length} providers, ` +
      `${Object.keys(config.harnesses).length} harnesses, ` +
      `${Object.keys(config.routes).length} routes)`
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length > 0 && argv[0] === "__exec") {
    return cmdExec(argv.slice(1));
  }

  // Shortcut form via direct invocation: `<harness>-<provider> [args...]`.
  // The invoked file name is recovered from the kernel-level argv (Bun
  // resolves symlinked argv[1]); native harness commands never come through
  // here (they are separate binaries).
  const invoked = invokedScriptPath();
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
    !["help", "--help", "-h", "--version", "-V", "list", "check", "models", "shortcuts", "select", "evaluate"].includes(first) &&
    !(first in config.harnesses) &&
    shortcutMap(config)[first]
  ) {
    return cmdRunShortcut(config, first, argv.slice(1));
  }

  if (first === "evaluate") {
    if (argv[1] === "calibrate") return cmdCalibrate(config, argv.slice(2));
    const { evaluationMain } = await import("./agent-eval");
    return evaluationMain(argv.slice(1));
  }
  if (first === "select") {
    const selected = parseArgs(argv.slice(1));
    if (selected[0] !== "run" || selected[4].length) throw new AgentError("usage: agent select <harness> <provider> [--model <id>] [--allow-unverified]");
    return cmdRun(config, selected[1], selected[2], selected[3], [], selected[5], true);
  }
  const action = parseArgs(argv);
  if (action[0] === "help") {
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
    return await cmdModels(config, action[1]);
  }
  if (action[0] === "shortcuts") {
    return cmdShortcuts(config, action[1]);
  }
  if (action[0] === "native") {
    const [, harnessKey, nativePassthru] = action;
    return cmdRunNative(config, harnessKey, nativePassthru);
  }
  const [, harnessKey, providerKey, model, passthru, allowUnverified] = action;
  return cmdRun(config, harnessKey, providerKey, model, passthru, allowUnverified);
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`${PROGRAM}: ${error.message}`);
    process.exit(error.code);
  }
  throw error;
}
