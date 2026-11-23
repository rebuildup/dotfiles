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
import { ContractError, DEFAULT_MAX_EVIDENCE_AGE_MS, parseTomlTable, redactJson, splitRouteKey } from "./contract.ts";;
import { routeDefaultModel, type Config, type Harness, type Provider, type Route } from "./config.ts";;
import { AgentError, EXIT_RUNTIME, EXIT_USAGE } from "./errors.ts";;
import { finalize, launchArgv, needsInjection, runInherited, startViaWithSecrets } from "./exec.ts";;
import { buildGuideData, buildHelpData, buildRoutesData, renderGuideText, renderRoutesText, UnknownGuideTopicError, usageText } from "./help.ts";;
import { buildPlan, resolveModel, type Plan } from "./plan.ts";;
import { checkPassthru, type TaskAction } from "./args.ts";
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
  let parsedToml: Record<string, unknown>;
  try {
    parsedToml = parseTomlTable(readFileSync(config.path, "utf8"), config.path);
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
  // Attestation freshness is time-dependent: committed e2e evidence older
  // than DEFAULT_MAX_EVIDENCE_AGE_MS silently disables every fallback
  // candidate (dotfiles#203). Surface rejections as warnings on every
  // `agent check` run — CI prints them — without failing the structural
  // check, since renewal needs real provider calls CI cannot perform.
  try {
    const catalogFacts = loadCatalog(config.path);
    const catalogLike = buildFallbackCatalog(config, catalogFacts);
    const attestationMap = mergeAttestations(
      seedAttestationsFromCatalog(catalogFacts),
      loadCatalogAttestations(),
    );
    for (const id of listFallbackProfiles(parsedToml)) {
      const profile = parseFallbackProfile(parsedToml, id);
      if (profile === null) continue;
      const resolution = resolveFallbackProfile(
        profile,
        catalogLike,
        attestationMap,
        getPrimaryQuotaScope(catalogFacts, profile.primaryRoute),
      );
      for (const rejected of resolution.rejected) {
        const target = rejected.candidate
          ? `${rejected.candidate.route}/${rejected.candidate.model}`
          : "(unresolved)";
        console.log(`warning: fallback '${id}' rejects ${target}: ${rejected.reason}`);
      }
    }
  } catch {
    // Resolution warnings are advisory; structural validation above already
    // failed closed on malformed input.
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

/**
 * `agent attest status [--json]`: report every fallback candidate's current
 * attestation state without executing providers. This is the read-only side of
 * the weekly renewal loop: stale/unknown entries identify exactly which
 * route+model pairs need a fresh measured E2E before they can be verified.
 */
export function cmdAttestStatus(config: Config, json: boolean): number {
  let parsedToml: Record<string, unknown>;
  try {
    parsedToml = parseTomlTable(readFileSync(config.path, "utf8"), config.path);
  } catch (error) {
    if (error instanceof ContractError) throw new AgentError(error.message, EXIT_USAGE);
    throw error;
  }
  let catalogFacts;
  try {
    catalogFacts = loadCatalog(config.path);
  } catch (error) {
    if (error instanceof ContractError) throw new AgentError(error.message, EXIT_RUNTIME);
    throw error;
  }
  const catalogLike = buildFallbackCatalog(config, catalogFacts);
  const attestationMap = mergeAttestations(
    seedAttestationsFromCatalog(catalogFacts),
    loadCatalogAttestations(),
  );
  let profileIds: string[];
  try {
    profileIds = listFallbackProfiles(parsedToml);
  } catch (error) {
    if (error instanceof ContractError) throw new AgentError(error.message, EXIT_USAGE);
    throw error;
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const id of profileIds) {
    let profile;
    try {
      profile = parseFallbackProfile(parsedToml, id);
    } catch (error) {
      if (error instanceof ContractError) throw new AgentError(error.message, EXIT_USAGE);
      throw error;
    }
    if (profile === null) continue;
    let resolution;
    try {
      resolution = resolveFallbackProfile(
        profile,
        catalogLike,
        attestationMap,
        getPrimaryQuotaScope(catalogFacts, profile.primaryRoute),
      );
    } catch (error) {
      if (error instanceof ContractError) throw new AgentError(error.message, EXIT_RUNTIME);
      throw error;
    }
    const usable = new Set(
      resolution.usable.map((u) => `${u.candidate.route}#${u.candidate.model}`),
    );
    for (const candidate of profile.candidates) {
      const key = `${candidate.route}#${candidate.model}`;
      const att = attestationMap.get(key);
      const value = att?.value;
      const valueStatus =
        typeof value === "object" && value !== null && typeof value.status === "string"
          ? value.status
          : null;
      const rejected = resolution.rejected.find(
        (r) => r.candidate?.route === candidate.route && r.candidate.model === candidate.model,
      );
      rows.push({
        profile: profile.id,
        route: candidate.route,
        model: candidate.model,
        usable: usable.has(key),
        reason: rejected?.reason ?? null,
        status: valueStatus ?? att?.status ?? "absent",
        provenance: (typeof value === "object" && value !== null ? value.provenance : null) ?? att?.provenance ?? null,
        evidence: (typeof value === "object" && value !== null ? value.evidence : null) ?? att?.evidence ?? null,
      });
    }
  }
  const generatedAt = new Date().toISOString();
  if (json) {
    console.log(redactJson({
      generatedAt,
      maxEvidenceAgeMs: DEFAULT_MAX_EVIDENCE_AGE_MS,
      candidates: rows,
    }));
    return 0;
  }
  console.log(
    `attestation status ${generatedAt} (max evidence age ${Math.round(DEFAULT_MAX_EVIDENCE_AGE_MS / 86400000)}d)`,
  );
  for (const row of rows) {
    const evidence = row.evidence as { at?: string; source?: string; sha?: string } | null;
    console.log(
      `${String(row.profile)} ${String(row.route)}/${String(row.model)}: ` +
        `${row.usable ? "usable" : String(row.reason ?? "unusable")} ` +
        `status=${String(row.status)} evidence=${evidence?.at ?? "none"} ` +
        `source=${evidence?.source ?? "none"} sha=${evidence?.sha ?? "none"}`,
    );
  }
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
export async function cmdTask(config: Config, action: TaskAction): Promise<number> {
  const sub = action[1];
  const arg = action[2];
  const task = await import("./task.ts");
  if (sub === "status") {
    const taskId = arg;
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
  if (sub === "reconcile") {
    const taskId = arg;
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new AgentError(`invalid task id '${taskId}'`, EXIT_USAGE);
    }
    let report;
    try {
      report = await task.reconcileTaskEffects(config, taskId);
    } catch (error) {
      if (error instanceof ContractError) {
        throw new AgentError(error.message, EXIT_RUNTIME);
      }
      throw error;
    }
    console.log(redactJson(report));
    // Still-pending effects keep the task fail-closed: nonzero exit so
    // automation cannot mistake "reconciled" for "safe to resume".
    return report.pending.length === 0 ? 0 : EXIT_RUNTIME;
  }
  if (sub === "resume") {
    const taskId = arg;
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new AgentError(`invalid task id '${taskId}'`, EXIT_USAGE);
    }
    const ro = action[3];
    // The runtime is recorded on the attempt, not the CLI: resume must probe
    // the SAME runtime that owns the worker (ADR-0021). Records written
    // before --runtime existed are Herdr attempts.
    const stored = task.loadTaskState(taskId);
    const runtime = stored?.currentAttempt?.runtime === "rex" ? "rex" : "herdr";
    const { runtimeAdapter } = await import("./runtime.ts");
    const rt = await runtimeAdapter(runtime).checkAvailable();
    if (!rt.available) {
      throw new AgentError(
        `${runtime} is not available (${rt.error ?? "unknown"}); task resume requires ${runtime}`,
        EXIT_RUNTIME,
      );
    }
    const prompt = ro.prompt ?? "Continue the previous task from where it stopped.";
    let result;
    try {
      result = await task.resumeTaskAttempt(config, taskId, prompt, { timeoutMs: ro.timeoutMs ?? undefined });
    } catch (error) {
      if (error instanceof ContractError) {
        throw new AgentError(error.message, EXIT_RUNTIME);
      }
      throw error;
    }
    console.log(redactJson({
      taskId: result.taskId,
      success: result.success,
      ...(result.acceptance ? { acceptance: result.acceptance } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.result !== undefined ? { result: result.result } : {}),
    }));
    const accepted = result.acceptance === undefined || result.acceptance.verified;
    return result.success && accepted ? 0 : EXIT_RUNTIME;
  }
  // sub === "run"
  const route = arg;
  const o = action[3];
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
  // the selected runtime itself is unavailable. The default stays Herdr;
  // --runtime rex selects the Rex path explicitly (ADR-0021).
  const runtime = o.runtime ?? "herdr";
  // --rex-host is meaningful only for the Rex runtime; silently ignoring it
  // under herdr would dispatch to the wrong execution target.
  if (o.rexHost && runtime !== "rex") {
    throw new AgentError("--rex-host requires --runtime rex", EXIT_USAGE);
  }
  const { runtimeAdapter } = await import("./runtime.ts");
  const rt = await runtimeAdapter(runtime).checkAvailable();
  if (!rt.available) {
    throw new AgentError(
      `${runtime} is not available (${rt.error ?? "unknown"}); task dispatch requires ${runtime}`,
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
      ...(o.allowUnobservedEffects ? { allowUnobservedEffects: true } : {}),
      ...(o.runtime ? { runtime: o.runtime } : {}),
      ...(o.rexHost ? { rexHost: o.rexHost } : {}),
      ...(o.cwd ? { cwd: o.cwd } : {}),
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
    ...(result.acceptance ? { acceptance: result.acceptance } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.result !== undefined ? { result: result.result } : {}),
  }));
  // Worker success AND verified acceptance are both required: an agent that
  // finished but failed its declared criteria is not a completed task.
  const accepted = result.acceptance === undefined || result.acceptance.verified;
  return result.success && accepted ? 0 : EXIT_RUNTIME;
}


// ---------------------------------------------------------------------------
// `agent review` — Antigravity visual review harness (dotfiles#219)
// ---------------------------------------------------------------------------

const REVIEW_USAGE =
  "usage: agent review run --image <path>... --spec <text>|--spec-file <path> " +
  "[--schema-file <path>] [--model <id>] [--out <dir>] [--protect <dir>] " +
  "[--executor local|herdr] [--timeout <ms>] [--no-quota] " +
  "[--min-remaining <0..1>] [--no-exclusive] | agent review quota";

/**
 * `agent review run|run-file`: single-shot `agy -p` review with layered
 * read-only verification. Exit 0 only for classification "review-completed";
 * every other outcome (denied ops, invalid output, auth, timeout, executor
 * failure) exits non-zero so schedulers fail closed. The result JSON is always
 * printed to stdout.
 */
export async function cmdReview(args: string[]): Promise<number> {
  const review = await import("./agy-review.ts");
  const sub = args[0];
  if (sub === "quota") {
    if (args.length > 1) {
      throw new AgentError("usage: agent review quota", EXIT_USAGE);
    }
    console.log(redactJson(await review.fetchAgyQuota()));
    return 0;
  }
  if (sub === "run-file") {
    const workdir = args[1];
    if (!workdir || args.length > 2) {
      throw new AgentError("usage: agent review run-file <workdir>", EXIT_USAGE);
    }
    const result = await review.runAgyReviewFile(workdir);
    console.log(redactJson(result));
    return result.classification === "review-completed" ? 0 : EXIT_RUNTIME;
  }
  if (sub !== "run") {
    throw new AgentError(REVIEW_USAGE, EXIT_USAGE);
  }

  const images: string[] = [];
  let spec: string | undefined;
  let specFile: string | undefined;
  let schemaFile: string | undefined;
  let model: string | undefined;
  let outDir: string | undefined;
  let protect: string | undefined;
  let executor: "local" | "herdr" | undefined;
  let timeoutMs: number | undefined;
  let skipQuota = false;
  let noOsSandbox = false;
  let agyBin: string | undefined;
  let minRemaining: number | undefined;
  let exclusive: boolean | undefined;

  const need = (flag: string, i: number): string => {
    const v = args[i + 1];
    if (v === undefined) throw new AgentError(`${flag} requires a value`, EXIT_USAGE);
    return v;
  };
  for (let i = 1; i < args.length; i++) {
    const t = args[i];
    switch (t) {
      case "--image": images.push(need(t, i)); i++; break;
      case "--spec": spec = need(t, i); i++; break;
      case "--spec-file": specFile = need(t, i); i++; break;
      case "--schema-file": schemaFile = need(t, i); i++; break;
      case "--model": model = need(t, i); i++; break;
      case "--out": outDir = need(t, i); i++; break;
      case "--protect": protect = need(t, i); i++; break;
      case "--executor": {
        const v = need(t, i); i++;
        if (v !== "local" && v !== "herdr") {
          throw new AgentError(`--executor must be local|herdr, got '${v}'`, EXIT_USAGE);
        }
        executor = v;
        break;
      }
      case "--timeout": {
        const v = need(t, i); i++;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new AgentError(`--timeout must be a positive number of ms, got '${v}'`, EXIT_USAGE);
        }
        timeoutMs = n;
        break;
      }
      case "--no-quota": skipQuota = true; break;
      case "--no-os-sandbox": noOsSandbox = true; break;
      case "--agy": agyBin = need(t, i); i++; break;
      case "--min-remaining": {
        const v = need(t, i); i++;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new AgentError(`--min-remaining must be a fraction in [0,1], got '${v}'`, EXIT_USAGE);
        }
        minRemaining = n;
        break;
      }
      case "--no-exclusive": exclusive = false; break;
      default:
        throw new AgentError(`unexpected argument '${t}'; ${REVIEW_USAGE}`, EXIT_USAGE);
    }
  }
  if (spec === undefined && specFile === undefined) {
    throw new AgentError(`--spec or --spec-file is required; ${REVIEW_USAGE}`, EXIT_USAGE);
  }

  let result;
  try {
    result = await review.runAgyReview({
      images,
      spec: spec ?? "",
      specFile,
      schemaFile,
      model,
      outDir,
      protect,
      executor,
      timeoutMs,
      skipQuota,
      noOsSandbox,
      agyBin,
      minRemaining,
      exclusive,
    });
  } catch (error) {
    if (error instanceof ContractError) {
      throw new AgentError(error.message, EXIT_RUNTIME);
    }
    throw error;
  }
  console.log(redactJson(result));
  return result.classification === "review-completed" ? 0 : EXIT_RUNTIME;
}
