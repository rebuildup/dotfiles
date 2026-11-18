#!/usr/bin/env bun
/**
 * Small shared runtime helpers for the agent router modules: a synchronous
 * sleep for lock-polling loops and an atomic file replace for local state.
 * Contract/schema concerns live in contract.ts; this module owns no state
 * layout and no domain rules.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** True on Windows hosts; single owner so every module agrees. */
export const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve `cmd` to an executable path: a path containing a separator is
 * checked directly, otherwise PATH is searched. On Windows PATHEXT
 * candidates are tried BEFORE the bare name because npm generates an
 * extensionless Bash-style shim next to `opencode.cmd` that is not a
 * Windows executable.
 */
export function which(cmd: string, pathEnv?: string): string | null {
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

/**
 * Standard synchronous sleep; works on a Bun/Node main thread. Intended for
 * short lock-polling waits on synchronous paths only.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomic replace: write a unique temp sibling, then rename(2) over the
 * target. rename(2) atomically replaces the destination on POSIX — a reader
 * sees either the old or the new complete file, never a tear. The temp file
 * is removed when the rename fails so a failed write leaves no litter.
 * Callers persist already-redacted content (see agentStateDir's invariant).
 */
export function writeFileAtomic(path: string, contents: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, contents, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the rename error is the one to report */
    }
    throw error;
  }
}

/**
 * Repository root containing config/agents.toml and script/. Resolved from
 * this module's own location so every importer agrees on one root.
 */
export function dotfilesRepoRoot(): string {
  return dirname(dirname(dirname(realpathSync(import.meta.path))));
}
