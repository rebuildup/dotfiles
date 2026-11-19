#!/usr/bin/env bun
/**
 * agents.toml contract for the agent launcher: the Provider/Harness/Route/
 * Config types, strict TOML loading (loadConfig), and route model-default
 * helpers. Extracted from script/agent.ts; shortcut naming is imported from
 * shortcuts.ts (no runtime cycle — shortcuts imports Config type-only).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject, parseTomlTable, splitRouteKey } from "./contract.ts";
import { AgentError } from "./errors.ts";
import { shortcutName } from "./shortcuts.ts";
import { dotfilesRepoRoot } from "./util.ts";

export interface Provider {
  key: string;
  label: string;
  base_url: string | null;
  secret: string | null;
  env: string | null;
  default_model: string | null;
  require_model: boolean;
  models: string[];
  opencode_id: string;
  omp_id: string;
  // Always source the credential from `secret` (Infisical): the ambient env
  // value is removed before the with-secrets stage, a missing Infisical value
  // fails, and OMP-local auth/model overrides are rejected. See
  // config/agents.toml [providers.opencode-go].
  require_infisical: boolean;
  // Credential-free endpoint (anonymous public free tier, e.g. OVHcloud AI
  // Endpoints). No secret is fetched, none is required and no credential env
  // name reaches the child; the endpoint must reject unknown/absent keys
  // itself. See config/agents.toml [providers.ovhcloud].
  anonymous: boolean;
  // OpenCode custom-provider registration (opencode adapter only): npm
  // package for base_url plus a per-model capability/limit contract. Set only
  // when the provider id is unknown to OpenCode's built-in catalog (see
  // config/agents.toml [providers.logfare]); the credential reaches OpenCode
  // as the env NAME, never as a value in config content or argv.
  opencode_npm: string | null;
  opencode_models: Record<string, OcModelSpec>;
  // Load a process-scoped OpenCode guard that makes HTTP 429 terminal.
  opencode_stop_on_429: boolean;
  // Endpoint spelling for the OpenCode custom-provider block when it differs
  // from `base_url`. Gateways often serve an OpenAI-compatible surface under
  // `/v1` but the Anthropic adapter must use the bare origin (it appends
  // `/v1/messages` itself). Absent = use `base_url`.
  opencode_base_url: string | null;
  // OMP custom provider (models.yml under a launcher-owned `--profile`).
  // Used when OMP has no native provider id for this endpoint: the launcher
  // generates ~/.omp/profiles/dotfiles-omp-<key>/agent/models.yml from this
  // provider's config and starts OMP with `--profile`. `apiKey` in that file
  // references the credential env NAME only — never a value.
  omp_custom: boolean;
  // Wire protocol for the generated models.yml entry (`api` field). Absent
  // defaults to "openai-completions".
  omp_api: string | null;
  // Per-model context/output contract for the generated models.yml entries.
  // Falls back to opencode_models.limit when an entry is absent there.
  omp_models: Record<string, OmpModelSpec>;
}

/** OpenCode model entry built from config: tool support + enforced limits. */
export interface OcModelSpec {
  tool_call: boolean;
  limit: { context: number; output: number };
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
}

/** OMP models.yml model limits: context window and max output tokens. */
export interface OmpModelSpec {
  context: number;
  output: number;
}

export interface Harness {
  key: string;
  label: string;
  command: string;
  adapter: string;
  env: Record<string, string>;
}

export interface Route {
  key: string;
  harness: string;
  provider: string;
  default_model: string | null;
  models: string[] | null;
  require_model: boolean;
  note: string;
}

export interface Config {
  path: string;
  drop_env: string[];
  providers: Record<string, Provider>;
  harnesses: Record<string, Harness>;
  routes: Record<string, Route>;
}

const ADAPTERS = ["anthropic", "opencode", "omp", "passthrough"];

export function configPath(): string {
  return process.env.AGENT_CONFIG || join(dotfilesRepoRoot(), "config", "agents.toml");
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
  if (!Array.isArray(value)) {
    throw new AgentError(`${where}: '${key}' must be a list of non-empty strings`);
  }
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      throw new AgentError(`${where}: '${key}' must be a list of non-empty strings`);
    }
    list.push(item);
  }
  if (new Set(list).size !== list.length) {
    throw new AgentError(`${where}: '${key}' contains duplicate entries`);
  }
  return list;
}

/**
 * Parse a provider's optional `opencode_models` table: one strict entry per
 * model (`tool_call`, `limit.context`/`limit.output`, and optional reasoning
 * effort). Unknown keys fail
 * closed so a typo can never silently drop a model's tool/limit contract and
 * no free-form passthrough (which could carry a credential) exists. Returns
 * null when the table is absent.
 */
function parseOcModels(
  table: Record<string, unknown>,
  where: string
): Record<string, OcModelSpec> | null {
  const raw = table["opencode_models"];
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new AgentError(`${where}: 'opencode_models' must be a table of model entries`);
  }
  const specs: Record<string, OcModelSpec> = {};
  for (const [modelId, entryValue] of Object.entries(raw)) {
    const entryWhere = `${where}.opencode_models.'${modelId}'`;
    if (!isPlainObject(entryValue)) {
      throw new AgentError(`${entryWhere}: table expected`);
    }
    const unknown = Object.keys(entryValue).filter(
      (k) => k !== "tool_call" && k !== "limit" && k !== "reasoning_effort",
    );
    if (unknown.length > 0) {
      throw new AgentError(`${entryWhere}: unknown key '${unknown[0]}'`);
    }
    const toolCall = entryValue["tool_call"];
    if (typeof toolCall !== "boolean") {
      throw new AgentError(`${entryWhere}: 'tool_call' must be a boolean`);
    }
    const limit = entryValue["limit"];
    if (!isPlainObject(limit)) {
      throw new AgentError(`${entryWhere}: 'limit' table with context and output expected`);
    }
    const limitUnknown = Object.keys(limit).filter((k) => k !== "context" && k !== "output");
    if (limitUnknown.length > 0) {
      throw new AgentError(`${entryWhere}: unknown limit key '${limitUnknown[0]}'`);
    }
    const context = limit["context"];
    const output = limit["output"];
    if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
      throw new AgentError(`${entryWhere}: limit.context must be a positive integer`);
    }
    if (typeof output !== "number" || !Number.isInteger(output) || output <= 0) {
      throw new AgentError(`${entryWhere}: limit.output must be a positive integer`);
    }
    const reasoningEffort = entryValue["reasoning_effort"];
    if (
      reasoningEffort !== undefined &&
      reasoningEffort !== "low" &&
      reasoningEffort !== "medium" &&
      reasoningEffort !== "high" &&
      reasoningEffort !== "xhigh"
    ) {
      throw new AgentError(`${entryWhere}: 'reasoning_effort' must be low, medium, high, or xhigh`);
    }
    specs[modelId] = {
      tool_call: toolCall,
      limit: { context, output },
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };
  }
  return specs;
}

/**
 * Parse a provider's optional `omp_models` table for OMP custom providers:
 * one strict entry per model (`context` + `output` token limits). Returns
 * null when the table is absent.
 */
function parseOmpModels(
  table: Record<string, unknown>,
  where: string
): Record<string, OmpModelSpec> | null {
  const raw = table["omp_models"];
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new AgentError(`${where}: 'omp_models' must be a table of model entries`);
  }
  const specs: Record<string, OmpModelSpec> = {};
  for (const [modelId, entryValue] of Object.entries(raw)) {
    const entryWhere = `${where}.omp_models.'${modelId}'`;
    if (!isPlainObject(entryValue)) {
      throw new AgentError(`${entryWhere}: table expected`);
    }
    const unknown = Object.keys(entryValue).filter((k) => k !== "context" && k !== "output");
    if (unknown.length > 0) {
      throw new AgentError(`${entryWhere}: unknown key '${unknown[0]}'`);
    }
    const positiveInt = (key: "context" | "output"): number => {
      const value = entryValue[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new AgentError(`${entryWhere}: '${key}' must be a positive integer`);
      }
      return value;
    };
    specs[modelId] = {
      context: positiveInt("context"),
      output: positiveInt("output"),
    };
  }
  return specs;
}

// Wire protocols OMP's models.yml `api` field accepts (docs: custom models &
// providers). Kept explicit so a typo fails at config load, not at first
// request.
const OMP_CUSTOM_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
]);

export function loadConfig(path?: string): Config {
  const configPathResolved = path || configPath();
  let text: string;
  try {
    text = readFileSync(configPathResolved, "utf8");
  } catch {
    throw new AgentError(`config not found: ${configPathResolved}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseTomlTable(text, configPathResolved);
  } catch (exc) {
    throw new AgentError(exc instanceof Error ? exc.message : String(exc));
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
    const env = optionalStr(table, "env", where) || secret;
    const models = stringList(table["models"] ?? [], where, "models");
    const default_model = optionalStr(table, "default_model", where);
    const require_model = table["require_model"] ?? false;
    if (typeof require_model !== "boolean") {
      throw new AgentError(`${where}: 'require_model' must be a boolean`);
    }
    const require_infisical = table["require_infisical"] ?? false;
    if (typeof require_infisical !== "boolean") {
      throw new AgentError(`${where}: 'require_infisical' must be a boolean`);
    }
    if (require_infisical && !secret) {
      throw new AgentError(
        `${where}: require_infisical = true requires an Infisical 'secret' name`
      );
    }
    const anonymous = table["anonymous"] ?? false;
    if (typeof anonymous !== "boolean") {
      throw new AgentError(`${where}: 'anonymous' must be a boolean`);
    }
    if (anonymous && (secret || env)) {
      // An anonymous endpoint must not also declare a credential: a combined
      // declaration would silently inject a key the endpoint ignores (or,
      // worse, reach a paid path with it). One or the other, never both.
      throw new AgentError(
        `${where}: anonymous = true contradicts 'secret'/'env' (an anonymous endpoint has no credential)`
      );
    }
    if (anonymous && !optionalStr(table, "base_url", where)) {
      throw new AgentError(`${where}: anonymous = true requires base_url`);
    }
    if (anonymous && require_infisical) {
      throw new AgentError(
        `${where}: anonymous = true contradicts require_infisical = true`
      );
    }
    const opencode_base_url = optionalStr(table, "opencode_base_url", where);
    if (opencode_base_url && !optionalStr(table, "opencode_npm", where)) {
      throw new AgentError(
        `${where}: opencode_base_url requires opencode_npm (it only re-spells the custom-provider endpoint)`
      );
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
    const opencode_npm = optionalStr(table, "opencode_npm", where);
    const opencode_models = parseOcModels(table, where);
    const opencode_stop_on_429 = table["opencode_stop_on_429"] ?? false;
    if (typeof opencode_stop_on_429 !== "boolean") {
      throw new AgentError(`${where}: 'opencode_stop_on_429' must be a boolean`);
    }
    const opencode_id = optionalStr(table, "opencode_id", where) || key;
    const ompCustom = table["omp_custom"] ?? false;
    if (typeof ompCustom !== "boolean") {
      throw new AgentError(`${where}: 'omp_custom' must be a boolean`);
    }
    const ompApi = optionalStr(table, "omp_api", where);
    const ompModels = parseOmpModels(table, where);
    const ompIdRaw = optionalStr(table, "omp_id", where);
    if (ompApi !== null && !OMP_CUSTOM_APIS.has(ompApi)) {
      throw new AgentError(
        `${where}: unknown omp_api '${ompApi}' (expected one of ${[...OMP_CUSTOM_APIS].join(", ")})`
      );
    }
    if (!ompCustom && (ompApi !== null || ompModels !== null)) {
      throw new AgentError(
        `${where}: omp_api/omp_models require omp_custom = true`
      );
    }
    if (ompCustom) {
      if (!optionalStr(table, "base_url", where)) {
        throw new AgentError(`${where}: omp_custom = true requires base_url`);
      }
      if (models.length === 0) {
        throw new AgentError(`${where}: omp_custom = true requires a models list`);
      }
      if (ompIdRaw !== null && ompIdRaw !== key) {
        // The models.yml provider id IS the config key; a divergent omp_id
        // would launch a selector the generated file does not define.
        throw new AgentError(
          `${where}: omp_custom = true requires omp_id to equal the provider key '${key}' (or be omitted)`
        );
      }
      if (!anonymous && !env) {
        throw new AgentError(
          `${where}: omp_custom = true requires a credential (secret/env name) or anonymous = true`
        );
      }
      if (ompModels) {
        const extra = Object.keys(ompModels).filter((id) => !models.includes(id));
        if (extra.length > 0) {
          throw new AgentError(
            `${where}: omp_models entry '${extra[0]}' is not in models [${models.join(", ")}]`
          );
        }
      }
    }
    if (opencode_models && !opencode_npm) {
      throw new AgentError(
        `${where}: opencode_models requires opencode_npm (a custom-provider registration)`
      );
    }
    if (opencode_npm) {
      // The block is assembled from these fields only, so a credential value
      // can never travel in it; each one must therefore exist.
      if (!optionalStr(table, "base_url", where)) {
        throw new AgentError(`${where}: opencode_npm requires base_url`);
      }
      if (!env && !anonymous) {
        throw new AgentError(
          `${where}: opencode_npm requires a credential (secret/env name), ` +
            "or anonymous = true for a credential-free endpoint"
        );
      }
      if (models.length === 0) {
        throw new AgentError(`${where}: opencode_npm requires a models list`);
      }
      const specs = opencode_models ?? {};
      const missing = models.filter((id) => !(id in specs));
      if (missing.length > 0) {
        throw new AgentError(
          `${where}: opencode_npm requires an opencode_models entry for every model; ` +
            `missing: ${missing.join(", ")}`
        );
      }
      const extra = Object.keys(specs).filter((id) => !models.includes(id));
      if (extra.length > 0) {
        throw new AgentError(
          `${where}: opencode_models entry '${extra[0]}' is not in models [${models.join(", ")}]`
        );
      }
    }
    if (opencode_stop_on_429) {
      const hydrogen = "gemini-4-hydrogen";
      if (
        key !== "gemini" ||
        opencode_id !== "gemini" ||
        models.length !== 1 ||
        models[0] !== hydrogen ||
        default_model !== hydrogen ||
        opencode_npm !== "@ai-sdk/openai-compatible" ||
        opencode_models?.[hydrogen]?.reasoning_effort !== "xhigh" ||
        secret !== "GEMINI_API_KEY" ||
        env !== "GEMINI_API_KEY" ||
        !require_infisical ||
        ompCustom
      ) {
        throw new AgentError(
          `${where}: opencode_stop_on_429 is reserved for the fixed Infisical-backed ` +
            "gemini-4-hydrogen xhigh OpenCode route",
        );
      }
    }
    providers[key] = {
      key,
      label: requireStr(table, "label", where),
      base_url: optionalStr(table, "base_url", where),
      secret,
      env,
      default_model,
      require_model,
      models,
      opencode_id,
      omp_id: ompIdRaw || key,
      require_infisical,
      anonymous,
      opencode_npm,
      opencode_models: opencode_models ?? {},
      opencode_stop_on_429,
      opencode_base_url: optionalStr(table, "opencode_base_url", where),
      omp_custom: ompCustom,
      omp_api: ompApi,
      omp_models: ompModels ?? {},
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
    if (!isPlainObject(envTable)) {
      throw new AgentError(`${where}: env must map string -> string (names only)`);
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(envTable)) {
      if (typeof value !== "string") {
        throw new AgentError(`${where}: env must map string -> string (names only)`);
      }
      env[name] = value;
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

  // Every claude-anthropic route needs an Anthropic-compatible endpoint;
  // an OpenCode custom-provider registration only the opencode adapter can
  // honor must not be declared silently inert: a provider that declares
  // `opencode_npm` must be reachable from at least one `opencode` route (a
  // gateway may legitimately serve the anthropic adapter on another route).
  const opencodeNpmProviders = new Set<string>();
  for (const route of Object.values(routes)) {
    const harness = harnesses[route.harness];
    const provider = providers[route.provider];
    if (harness.adapter === "anthropic" && !provider.base_url) {
      throw new AgentError(
        `routes.${route.key}: adapter anthropic needs provider '${provider.key}' to declare base_url`
      );
    }
    if (provider.opencode_npm && harness.adapter === "opencode") {
      opencodeNpmProviders.add(provider.key);
    }
  }
  for (const provider of Object.values(providers)) {
    if (provider.opencode_npm && !opencodeNpmProviders.has(provider.key)) {
      throw new AgentError(
        `provider '${provider.key}' declares opencode_npm but no 'opencode' route uses it; ` +
          "the custom-provider block would sit silently inert (add an opencode route or drop the block)"
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

export function effectiveModels(route: Route, provider: Provider): string[] {
  return route.models ?? provider.models;
}

export function routeRequiresModel(route: Route, provider: Provider): boolean {
  return route.require_model || provider.require_model;
}

export function routeDefaultModel(route: Route, provider: Provider): string | null {
  return route.default_model || provider.default_model;
}

function validateRouteDefaults(route: Route, provider: Provider): void {
  const where = `routes.'${route.key}'`;
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

