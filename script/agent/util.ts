#!/usr/bin/env bun
/**
 * Small shared runtime helpers for the agent router modules: a synchronous
 * sleep for lock-polling loops and an atomic file replace for local state.
 * Contract/schema concerns live in contract.ts; this module owns no state
 * layout and no domain rules.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

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
