#!/usr/bin/env bun
// Compose the effective Claude Code user settings from:
//   - the shared baseline   agents/claude/settings.json   (submodule, canonical)
//   - a machine-local overlay  ~/.config/dotfiles/claude/settings.local.json
// into the live file ~/.claude/settings.json (generated, never a symlink).
//
// Machine-specific values (e.g. the Herdr SessionStart hook) that Herdr or the
// user wrote into the live file are imported into the overlay before the live
// file is regenerated, so they survive. An unmanaged or modified live file is
// backed up before it is replaced. Nothing is overwritten silently.
//
// Usage: bun script/claude-settings.ts compose | check

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Canonical JSON with sorted keys, used for equality and array de-duplication.
export function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// Effective = shared baseline with overlay on top. Objects merge key by key,
// arrays append overlay items not already present, scalars take the overlay.
export function merge(base: Json, overlay: Json): Json {
  if (isObj(base) && isObj(overlay)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      out[k] = k in base ? merge(base[k], v) : v;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(overlay)) {
    const seen = new Set(base.map(stable));
    const out: Json[] = [...base];
    for (const v of overlay) {
      const key = stable(v);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
    return out;
  }
  return overlay;
}

// The part of `live` that the shared baseline does not already express.
// undefined means live adds nothing beyond shared.
export function extras(shared: Json | undefined, live: Json): Json | undefined {
  if (isObj(live)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(live)) {
      if (!isObj(shared) || !(k in shared)) {
        out[k] = v;
        continue;
      }
      const e = extras(shared[k], v);
      if (e !== undefined) out[k] = e;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (Array.isArray(live)) {
    const sharedKeys = new Set(Array.isArray(shared) ? shared.map(stable) : []);
    const out = live.filter((v) => !sharedKeys.has(stable(v)));
    return out.length > 0 ? out : undefined;
  }
  if (shared !== undefined && stable(shared) === stable(live)) return undefined;
  return live;
}

// Returns the path of the first scalar that would be silently changed, if any.
export function scalarConflict(overlay: Json, incoming: Json, path = ""): string | undefined {
  if (isObj(overlay) && isObj(incoming)) {
    for (const [k, v] of Object.entries(incoming)) {
      if (!(k in overlay)) continue;
      const hit = scalarConflict(overlay[k], v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
    return undefined;
  }
  if (Array.isArray(overlay) && Array.isArray(incoming)) return undefined;
  return stable(overlay) === stable(incoming) ? undefined : path || "(root)";
}

export interface Paths {
  shared: string;
  overlay: string;
  target: string;
  stateFile: string;
}

export interface Plan {
  status: "skip" | "ok" | "drift";
  reason?: string;
  effective?: Json;
  overlayAfter?: Json; // set when the overlay must change
  backupNeeded?: boolean;
  replaceSymlink?: boolean;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function readJsonFile(path: string, label: string): Json {
  let parsed: Json;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path} (${(error as Error).message})`);
  }
  return parsed;
}

function readState(stateFile: string): string | undefined {
  try {
    return readFileSync(stateFile, "utf8").trim();
  } catch {
    return undefined;
  }
}

// Pure planning: decides what compose would do without touching the disk.
export function plan(paths: Paths): Plan {
  if (!existsSync(paths.shared)) {
    return {
      status: "skip",
      reason: `shared baseline missing: ${paths.shared} (run: git submodule update --init agents/claude)`,
    };
  }
  const shared = readJsonFile(paths.shared, "shared baseline");
  if (!isObj(shared)) throw new Error(`shared baseline must be a JSON object: ${paths.shared}`);

  const overlay: Json = existsSync(paths.overlay) ? readJsonFile(paths.overlay, "overlay") : {};
  if (!isObj(overlay)) throw new Error(`overlay must be a JSON object: ${paths.overlay}`);

  let overlayAfter: Json | undefined;
  let backupNeeded = false;
  let replaceSymlink = false;

  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(paths.target);
  } catch {
    stat = undefined;
  }

  if (stat?.isSymbolicLink()) {
    // A symlink is only replaceable when it points at the shared baseline
    // (the earlier direct-link layout). Any other symlink is not ours.
    let real: string | undefined;
    try {
      real = realpathSync(paths.target);
    } catch {
      real = undefined;
    }
    if (real !== realpathSync(paths.shared)) {
      throw new Error(
        `${paths.target} is a symlink to ${real ?? "a missing path"}, not the shared baseline; move it aside manually`,
      );
    }
    replaceSymlink = true;
  } else if (stat?.isFile()) {
    const text = readFileSync(paths.target, "utf8");
    const live = readJsonFile(paths.target, "live settings");
    const generated = readState(paths.stateFile);
    if (generated !== sha(text)) {
      // Unmanaged, or changed since we generated it (for example by Herdr).
      // Import what the live file adds beyond shared, then back it up.
      const added = extras(shared, live);
      if (added !== undefined) {
        const hit = scalarConflict(overlay, added);
        if (hit) {
          throw new Error(
            `live settings conflict with overlay at "${hit}"; resolve in ${paths.overlay} before composing`,
          );
        }
        overlayAfter = merge(overlay, added);
      }
      backupNeeded = true;
    }
  } else if (stat) {
    throw new Error(`${paths.target} exists but is not a regular file`);
  }

  const effective = merge(shared, overlayAfter ?? overlay);
  const effText = `${JSON.stringify(effective, null, 2)}\n`;

  const upToDate =
    stat?.isFile() === true &&
    !backupNeeded &&
    overlayAfter === undefined &&
    readFileSync(paths.target, "utf8") === effText &&
    readState(paths.stateFile) === sha(effText);

  return {
    status: upToDate ? "ok" : "drift",
    effective,
    overlayAfter,
    backupNeeded,
    replaceSymlink,
  };
}

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

// Applies a plan. The live file is backed up before replacement, never removed.
export function compose(paths: Paths): string[] {
  const actions: string[] = [];
  const p = plan(paths);
  if (p.status === "skip") return [`skip    ${p.reason}`];
  if (p.status === "ok") return [`ok      ${paths.target}`];

  if (p.overlayAfter !== undefined) {
    writeAtomic(paths.overlay, `${JSON.stringify(p.overlayAfter, null, 2)}\n`);
    actions.push(`overlay ${paths.overlay} (imported live-only settings)`);
  }
  if (p.replaceSymlink) {
    unlinkSync(paths.target);
    actions.push(`unlink  ${paths.target} (old shared-baseline symlink)`);
  } else if (p.backupNeeded) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${paths.target}.pre-dotfiles-${stamp}`;
    // COPYFILE_EXCL: a backup is never overwritten.
    copyFileSync(paths.target, backup, constants.COPYFILE_EXCL);
    actions.push(`backup  ${paths.target} -> ${backup}`);
  }

  const text = `${JSON.stringify(p.effective, null, 2)}\n`;
  writeAtomic(paths.target, text);
  writeAtomic(paths.stateFile, `${sha(text)}\n`);
  actions.push(`write   ${paths.target}`);
  return actions;
}

export function pathsFor(home: string, repoRoot: string): Paths {
  const stateDir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "dotfiles", "claude");
  return {
    shared: join(repoRoot, "agents", "claude", "settings.json"),
    overlay: join(stateDir, "settings.local.json"),
    target: join(home, ".claude", "settings.json"),
    stateFile: join(stateDir, "settings.generated.sha256"),
  };
}

function main() {
  const command = process.argv[2];
  if (command !== "compose" && command !== "check") {
    console.error("usage: bun script/claude-settings.ts compose | check");
    process.exit(2);
  }
  const home = process.env.HOME;
  if (!home) throw new Error("HOME must be set");
  const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
  const paths = pathsFor(home, repoRoot);

  if (command === "check") {
    const p = plan(paths);
    if (p.status === "skip") {
      console.log(`skip    ${p.reason}`);
      return;
    }
    if (p.status === "ok") {
      console.log(`ok      ${paths.target}`);
      return;
    }
    console.error(`drift   ${paths.target} differs from the composed settings; run script/bootstrap or script/claude-settings compose`);
    process.exit(1);
  }

  // compose CLI is invoked from script/bootstrap with a synced submodule.
  // A "skip" result means the shared baseline is missing or unreadable;
  // surface it as a non-zero exit so bootstrap does not silently leave
  // ~/.claude/settings.json stale. script/check still tolerates skip because
  // a check-only invocation against a tree without submodules is a valid
  // read of "nothing to verify".
  const actions = compose(paths);
  for (const line of actions) console.log(line);
  if (actions.some((line) => line.startsWith("skip "))) {
    process.exit(1);
  }
}

if (import.meta.main) main();
