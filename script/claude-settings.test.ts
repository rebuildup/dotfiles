import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compose, extras, merge, type Paths, plan, scalarConflict } from "./claude-settings";

const SHARED = {
  permissions: { defaultMode: "bypassPermissions", allow: ["Bash(git status)"] },
  statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh" },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "shared-start" }] }] },
};

const HERDR_HOOK = { hooks: [{ type: "command", command: "herdr-session-start" }] };

function fixture(): Paths & { root: string; sharedDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-settings-")));
  const sharedDir = join(root, "repo", "agents", "claude");
  mkdirSync(sharedDir, { recursive: true });
  const shared = join(sharedDir, "settings.json");
  writeFileSync(shared, JSON.stringify(SHARED, null, 2));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const stateDir = join(home, ".config", "dotfiles", "claude");
  return {
    root,
    sharedDir,
    shared,
    overlay: join(stateDir, "settings.local.json"),
    target: join(home, ".claude", "settings.json"),
    stateFile: join(stateDir, "settings.generated.sha256"),
  };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("merge / extras / scalarConflict", () => {
  test("arrays append and de-duplicate; objects merge; overlay scalars win", () => {
    const out = merge(
      { a: [1, 2], o: { x: 1, keep: true }, s: "shared" },
      { a: [2, 3], o: { x: 9 }, s: "local" },
    ) as Record<string, unknown>;
    expect(out).toEqual({ a: [1, 2, 3], o: { x: 9, keep: true }, s: "local" });
  });

  test("extras returns only what live adds beyond shared", () => {
    const e = extras(SHARED, {
      ...SHARED,
      hooks: { SessionStart: [...SHARED.hooks.SessionStart, HERDR_HOOK] },
      extraKey: 1,
    });
    expect(e).toEqual({ hooks: { SessionStart: [HERDR_HOOK] }, extraKey: 1 });
  });

  test("extras is undefined when live equals shared", () => {
    expect(extras(SHARED, structuredClone(SHARED))).toBeUndefined();
  });

  test("scalarConflict reports changed scalars but not array additions", () => {
    expect(scalarConflict({ statusLine: { command: "a" } }, { statusLine: { command: "b" } })).toBe(
      "statusLine.command",
    );
    expect(scalarConflict({ hooks: [1] }, { hooks: [2] })).toBeUndefined();
  });
});

describe("compose", () => {
  test("fresh machine: writes shared baseline and state, idempotent on rerun", () => {
    const p = fixture();
    compose(p);
    expect(read(p.target)).toEqual(SHARED);
    expect(lstatSync(p.target).isSymbolicLink()).toBe(false);
    expect(plan(p).status).toBe("ok");
    expect(compose(p)).toEqual([`ok      ${p.target}`]);
  });

  test("unmanaged live file: Herdr hook and extra keys are kept, original backed up", () => {
    const p = fixture();
    const live = {
      ...SHARED,
      hooks: { SessionStart: [...SHARED.hooks.SessionStart, HERDR_HOOK] },
      localOnly: { theme: "dark" },
    };
    writeFileSync(p.target, JSON.stringify(live, null, 2));

    const actions = compose(p);

    expect(actions.some((a) => a.startsWith("backup"))).toBe(true);
    const backups = readdirSync(join(p.target, ".."))
      .filter((n) => n.startsWith("settings.json.pre-dotfiles-"));
    expect(backups.length).toBe(1);
    expect(read(join(join(p.target, ".."), backups[0]))).toEqual(live);

    const effective = read(p.target);
    expect(effective.statusLine).toEqual(SHARED.statusLine);
    expect(effective.hooks.SessionStart).toContainEqual(HERDR_HOOK);
    expect(effective.localOnly).toEqual({ theme: "dark" });
    expect(read(p.overlay).hooks.SessionStart).toEqual([HERDR_HOOK]);
    expect(plan(p).status).toBe("ok");
  });

  test("Herdr rewrites the generated file: its additions are imported, not lost", () => {
    const p = fixture();
    compose(p);
    const rewritten = read(p.target);
    rewritten.hooks.SessionStart.push(HERDR_HOOK);
    writeFileSync(p.target, JSON.stringify(rewritten, null, 2));
    expect(plan(p).status).toBe("drift");

    compose(p);

    expect(read(p.overlay).hooks.SessionStart).toEqual([HERDR_HOOK]);
    expect(read(p.target).hooks.SessionStart).toContainEqual(HERDR_HOOK);
    expect(plan(p).status).toBe("ok");
  });

  test("conflicting scalar with the overlay aborts before any change", () => {
    // scalarConflict only flags scalar divergence; arrays re-append cleanly.
    // Use permissions.defaultMode (a scalar shared baseline value) so the
    // conflict is reproducible.
    const p = fixture();
    mkdirSync(join(p.overlay, ".."), { recursive: true });
    writeFileSync(p.overlay, JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
    const live = { ...SHARED, permissions: { ...SHARED.permissions, defaultMode: "plan" } };
    writeFileSync(p.target, JSON.stringify(live, null, 2));

    expect(() => compose(p)).toThrow(/conflict with overlay at "permissions\.defaultMode"/);
    expect(read(p.target)).toEqual(live);
    expect(read(p.overlay)).toEqual({ permissions: { defaultMode: "acceptEdits" } });
  });

  test("invalid JSON in the live file aborts and leaves it untouched", () => {
    const p = fixture();
    writeFileSync(p.target, "{ not json");
    expect(() => compose(p)).toThrow(/not valid JSON/);
    expect(readFileSync(p.target, "utf8")).toBe("{ not json");
  });

  test("foreign symlink aborts; old symlink to the shared baseline is replaced without touching shared", () => {
    const p = fixture();
    const other = join(p.root, "other.json");
    writeFileSync(other, "{}");
    symlinkSync(other, p.target);
    expect(() => compose(p)).toThrow(/move it aside manually before composing/);
    expect(readFileSync(other, "utf8")).toBe("{}");

    unlinkSync(p.target);
    symlinkSync(p.shared, p.target);
    compose(p);
    expect(lstatSync(p.target).isSymbolicLink()).toBe(false);
    expect(read(p.target)).toEqual(SHARED);
    expect(read(p.shared)).toEqual(SHARED);
  });

  test("missing shared baseline is a skip, not an error", () => {
    const p = fixture();
    rmSync(p.shared);
    writeFileSync(p.target, "keep");
    expect(compose(p)[0]).toMatch(/^skip /);
    expect(readFileSync(p.target, "utf8")).toBe("keep");
  });

  test("dangling symlink to old home/.claude/settings.json is migrated to a fresh composed file", () => {
    // Reproduces the real-machine failure: a pre-0.3.0 install left
    // ~/.claude/settings.json -> ~/.dotfiles/home/.claude/settings.json.
    // After upgrading dotfiles the source file is gone and the symlink is
    // dangling. The composer must unlink it and produce a fresh regular file
    // instead of asking the operator to clean up by hand.
    const p = fixture();
    const oldLayout = join(p.root, "repo", "home", ".claude", "settings.json");
    symlinkSync(oldLayout, p.target);

    const actions = compose(p);

    expect(actions.some((a) => a.startsWith("unlink"))).toBe(true);
    expect(actions.some((a) => a.startsWith("backup"))).toBe(false);
    expect(lstatSync(p.target).isSymbolicLink()).toBe(false);
    expect(read(p.target)).toEqual(SHARED);
    expect(plan(p).status).toBe("ok");
    expect(compose(p)).toEqual([`ok      ${p.target}`]);
  });

  test("symlink to existing old home/.claude/settings.json backs the target up and composes fresh", () => {
    // When the old layout file still exists on disk (e.g. the user has
    // edited it through the symlink), the composer copies it aside before
    // removing the symlink so the user-customised content is preserved.
    const p = fixture();
    const oldLayout = join(p.root, "repo", "home", ".claude", "settings.json");
    mkdirSync(dirname(oldLayout), { recursive: true });
    writeFileSync(oldLayout, JSON.stringify(SHARED, null, 2));
    symlinkSync(oldLayout, p.target);

    const actions = compose(p);

    expect(actions.some((a) => a.startsWith("backup"))).toBe(true);
    expect(actions.some((a) => a.startsWith("unlink"))).toBe(true);
    const backups = readdirSync(dirname(oldLayout)).filter(
      (n) => n.startsWith("settings.json.pre-dotfiles-"),
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(lstatSync(p.target).isSymbolicLink()).toBe(false);
    expect(read(p.target)).toEqual(SHARED);
    expect(plan(p).status).toBe("ok");
  });

  test("Orca rewrites statusLine on the live file: shared statusLine is restored, Orca hook survives", () => {
    // Orca installs a SessionStart hook that rewrites statusLine on the live
    // file for its own progress notifications. The composer must:
    //   - keep the shared statusLine (the user owns the canonical render),
    //   - import the Orca hook into the overlay (machine-specific value),
    //   - never transfer the rewritten statusLine into the overlay.
    const p = fixture();
    const orcaStatus = {
      type: "command",
      command: "orca-agent statusline --token=$ORCA_AGENT_HOOK_TOKEN",
    };
    const orcaHook = {
      hooks: [{ type: "command", command: "orca-session-start" }],
    };
    const live = {
      ...SHARED,
      statusLine: orcaStatus,
      hooks: {
        ...SHARED.hooks,
        SessionStart: [...SHARED.hooks.SessionStart, orcaHook],
      },
    };
    writeFileSync(p.target, JSON.stringify(live, null, 2));

    compose(p);

    const composed = read(p.target);
    expect(composed.statusLine).toEqual(SHARED.statusLine);
    expect(composed.hooks.SessionStart).toContainEqual(orcaHook);
    const overlay = read(p.overlay);
    expect(overlay.statusLine).toBeUndefined();
    expect(overlay.hooks.SessionStart).toContainEqual(orcaHook);
    expect(plan(p).status).toBe("ok");
  });
});

