#!/usr/bin/env bun
/**
 * Plan building for the agent launcher: the Plan contract, route model
 * resolution, and the per-adapter plan builders (anthropic, opencode, omp
 * via planOmp, passthrough). Extracted from script/agent.ts; exec markers
 * come from exec.ts and passthru policy from args.ts (no runtime cycles).
 */

import { join } from "node:path";
import { AgentError } from "./errors.ts";
import { checkPassthru } from "./args.ts";
import {
  effectiveModels,
  routeDefaultModel,
  type Config,
  type Harness,
  type OcModelSpec,
  type Provider,
  type Route,
} from "./config.ts";
import { CRED_MARKER, MODEL_MARKER, PLUGIN_MARKER, PROVIDER_MARKER } from "./exec.ts";
import { planOmp } from "./omp.ts";
import { dotfilesRepoRoot } from "./util.ts";

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



export function resolveModel(route: Route, provider: Provider, cliModel: string | null): string {
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
// Plan building (adapters = verified native CLI contracts)
// ---------------------------------------------------------------------------

export function buildPlan(
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
      models[id] = {
        tool_call: spec.tool_call,
        limit: spec.limit,
        ...(spec.reasoning_effort
          ? { settings: { reasoningEffort: spec.reasoning_effort } }
          : {}),
      };
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
    if (provider.opencode_stop_on_429) {
      // This path is attached last so the terminal quota hook runs after
      // any caller-supplied plugins in the merged inline configuration.
      plan.assign.push([
        configEnv,
        PLUGIN_MARKER +
          JSON.stringify(
            join(dotfilesRepoRoot(), "script", "agent", "opencode-gemini-free-tier"),
          ),
      ]);
    }
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
