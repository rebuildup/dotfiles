#!/usr/bin/env bun
/**
 * Subcommand implementations for the agent launcher CLI: run/native/
 * shortcut dispatch, list/models/check, help/guide/routes/fallback
 * reporting, and task dispatch. Extracted from script/agent.ts; the
 * entrypoint (agent.ts) owns only argv intake, shortcut detection, and
 * dispatch.
 */

import { randomUUID } from "node:crypto";;
import { readFileSync } from "node:fs";;
import { join } from "node:path";;
import { getPrimaryQuotaScope, loadCatalog } from "./catalog.ts";;
import { buildFallbackCatalog, listFallbackProfiles, loadCatalogAttestations, mergeAttestations, parseFallbackProfile, resolveFallbackProfile, renderFallbackResolution, seedAttestationsFromCatalog } from "./fallback.ts";;
import { ContractError, parseTomlTable, redactJson, splitRouteKey } from "./contract.ts";;
import { routeDefaultModel, type Config, type Harness, type Provider, type Route } from "./config.ts";;
import { AgentError, EXIT_RUNTIME, EXIT_USAGE } from "./errors.ts";;
import { finalize, launchArgv, needsInjection, runInherited, startViaWithSecrets } from "./exec.ts";;
import { buildGuideData, buildHelpData, buildRoutesData, renderGuideText, renderRoutesText, UnknownGuideTopicError, usageText } from "./help.ts";;
import { buildPlan, resolveModel, type Plan } from "./plan.ts";;
import { checkPassthru } from "./args.ts";;
import { parseShortcutArgs, resolveShortcut, shortcutName } from "./shortcuts.ts";;
import { PROGRAM, which } from "./util.ts";;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function requireHarness(config: Config, harnessKey: string): Harness {
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

export function selectRoute(config: Config, harnessKey: string, providerKey: string): [Harness, Provider, Route] {
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

export async function cmdRun(
  config: Config,
  harnessKey: string,
  providerKey: string,
  cliModel: string | null,
  passthru: string[],
  launcherTarget: string
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
    return startViaWithSecrets(plan, Object.keys(process.env).sort(), launcherTarget);
  }
  return finalize(plan);
}

export function cmdRunShortcut(config: Config, name: string, argv: string[], launcherTarget: string): Promise<number> {
  const [harnessKey, providerKey] = resolveShortcut(config, name);
  const { model, passthru } = parseShortcutArgs(argv);
  return cmdRun(config, harnessKey, providerKey, model, passthru, launcherTarget);
}

export function cmdRunNative(config: Config, harnessKey: string, passthru: string[]): Promise<number> {
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

export function cmdList(config: Config): number {
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

export function cmdModels(config: Config, providerKey: string): number {
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

export function cmdCheck(config: Config): number {
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
export function cmdHelpJson(config: Config): number {
  console.log(redactJson(buildHelpData(usageText())));
  return 0;
}

/**
 * `agent guide [topic] [--json]`: progressive disclosure. The overview lists
 * the topics; each topic is read on demand — no giant always-on prompt.
 */
export function cmdGuide(argv: string[]): number {
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
export function cmdRoutes(config: Config, argv: string[]): number {
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
export function cmdFallback(config: Config, profileId: string, json: boolean): number {
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
export async function cmdTask(
  config: Config,
  sub: string,
  arg: string | Record<string, unknown> | undefined,
  opts?: Record<string, unknown>,
): Promise<number> {
  const task = await import("./task.ts");
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
  const { checkHerdrAvailable } = await import("./herdr.ts");
  const herdr = await checkHerdrAvailable();
  if (!herdr.available) {
    throw new AgentError(
      `Herdr is not available (${herdr.error ?? "unknown"}); task dispatch requires Herdr`,
      EXIT_RUNTIME,
    );
  }
  const taskId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  let result;
  try {
    result = await task.runTaskToCompletion(config, {
      id: taskId,
      route,
      model,
      prompt: prompt.trim(),
      ...(o.fallback ? { profileId: o.fallback } : {}),
      ...(o.accept.length > 0 ? { acceptanceCriteria: o.accept } : {}),
      ...(o.timeoutMs !== null ? { timeoutMs: o.timeoutMs } : {}),
    });
  } catch (error) {
    // ContractError carries the classified reason (bad route/model/profile,
    // missing credential, Herdr state); surface it as a launcher error, not
    // a raw stack trace.
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }
  console.log(redactJson({
    taskId: result.taskId,
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.result !== undefined ? { result: result.result } : {}),
  }));
  return result.success ? 0 : EXIT_RUNTIME;
}

