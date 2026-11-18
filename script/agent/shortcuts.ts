#!/usr/bin/env bun
/**
 * Shortcut form for the agent launcher: `<harness>-<provider>` invoked
 * directly (symlink to script/agent.ts on Unix, generated .cmd on Windows).
 * Owns shortcut naming/resolution, launcher-argv parsing, and link
 * management under the shortcut bin dir. Extracted from script/agent.ts;
 * Config is imported type-only (no runtime cycle).
 */

import { basename, join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { splitRouteKey } from "./contract.ts";
import { AgentError, EXIT_RUNTIME } from "./errors.ts";
import { IS_WINDOWS, which } from "./util.ts";
import type { Config } from "./config.ts";

const SHORTCUT_MODEL_FLAG = "--agent-model";
const WINDOWS_CMD_MARKER = "rem managed-by: agent-launcher";

// ---------------------------------------------------------------------------
// Shortcut form: `<harness>-<provider>` invoked directly (symlink to this
// script on Unix, generated .cmd on Windows). The name is resolved by exact
// match against the configured routes, never by splitting on hyphens.
// ---------------------------------------------------------------------------

export function shortcutName(harnessKey: string, providerKey: string): string {
  return `${harnessKey}-${providerKey}`;
}

export function shortcutMap(config: Config): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const key of Object.keys(config.routes)) {
    const [harness_key, provider_key] = splitRouteKey(key);
    mapping[shortcutName(harness_key, provider_key)] = key;
  }
  return mapping;
}

export function resolveShortcut(config: Config, name: string): [string, string] {
  const routeKey = shortcutMap(config)[name];
  if (!routeKey) {
    if (name.startsWith("pi-")) {
      // Stale links from the retired Pi Worker slot still point at this
      // launcher. Name the replacement and the exact path to remove; the
      // launcher never deletes a link it did not create in this generation.
      throw new AgentError(
        `'${name}' is a retired Pi Worker shortcut; the slot moved to OMP. ` +
          `Use '${name.replace(/^pi-/, "omp-")}' after 'agent shortcuts create', ` +
          `and remove the stale link if present: rm ${join(binDir(), name)}`
      );
    }
    const known = Object.keys(shortcutMap(config)).sort().join(", ");
    throw new AgentError(
      `unknown shortcut '${name}'; shortcuts exist for these routes: ${known}\n` +
        "Define the route in config/agents.toml and run 'agent shortcuts create' to link it."
    );
  }
  const [harnessKey, providerKey] = splitRouteKey(routeKey);
  return [harnessKey, providerKey];
}

export function parseShortcutArgs(argv: string[]): { model: string | null; passthru: string[] } {
  // Shortcut argv: only --agent-model is launcher-owned, the rest is the
  // harness's own argument vector (passed verbatim, no '--' required).
  let model: string | null = null;
  const passthru: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
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
  return { model, passthru };
}

/**
 * Recover the script path this process was invoked as. Bun resolves the
 * symlinked argv[1] to the real file, so the kernel-level argv is consulted
 * instead: /proc/self/cmdline on Linux (WSL included), `ps` on macOS.
 */
export function invokedScriptPath(launcherBase: string): string | null {
  const a1 = process.argv[1];
  if (a1) {
    const base = basename(a1);
    if (base !== launcherBase && base !== "bun") {
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
  if (token && basename(token) !== launcherBase && basename(token) !== "bun") {
    return token;
  }
  return null;
}

function binDir(): string {
  if (process.env.AGENT_BIN_DIR) return process.env.AGENT_BIN_DIR;
  return join(homedir(), ".local", "bin");
}

function shortcutPath(name: string): string {
  const ext = IS_WINDOWS ? ".cmd" : "";
  return join(binDir(), `${name}${ext}`);
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

export function cmdShortcuts(config: Config, action: string | null, launcherTarget: string): number {
  const target = launcherTarget;
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

