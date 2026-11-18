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

import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { AgentError, EXIT_USAGE } from "./agent/errors";
import { PROGRAM } from "./agent/util";
import {
  cmdShortcuts,
  invokedScriptPath,
  shortcutMap,
} from "./agent/shortcuts";
import { configPath, loadConfig } from "./agent/config";
import { parseArgs } from "./agent/args";
import { cmdExec } from "./agent/exec";
import { usageText } from "./agent/help";
import {
  cmdCheck,
  cmdFallback,
  cmdGuide,
  cmdHelpJson,
  cmdList,
  cmdModels,
  cmdRoutes,
  cmdRun,
  cmdRunNative,
  cmdRunShortcut,
  cmdTask,
} from "./agent/commands";

const LAUNCHER_BASENAME = basename(import.meta.path);


/** Real path of this launcher; shortcut links must point here, never at a
 * module inside script/agent/ (import.meta.path differs per file). */
function launcherLinkTarget(): string {
  return realpathSync(import.meta.path);
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
      return cmdRunShortcut(config, name, argv, launcherLinkTarget());
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
    return cmdRunShortcut(config, first, argv.slice(1), launcherLinkTarget());
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
    return cmdTask(config, action);
  }
  if (action[0] === "native") {
    const [, harnessKey, nativePassthru] = action;
    return cmdRunNative(config, harnessKey, nativePassthru);
  }
  const [, harnessKey, providerKey, model, passthru] = action;
  return cmdRun(config, harnessKey, providerKey, model, passthru, launcherLinkTarget());
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
