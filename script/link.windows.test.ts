#!/usr/bin/env bun
/**
 * Windows-only tests for script/link.ps1, the adoption-first symlink adapter.
 *
 * Each test builds a throwaway git repo with a home/ tree and a throwaway
 * HOME, so nothing outside the temp directory is read or changed. Runs in
 * the windows-latest CI job (symlink creation needs an elevated runner).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LINK_PS1 = join(dirname(dirname(realpathSync(import.meta.path))), "script", "link.ps1");

const describeWin = process.platform !== "win32" ? describe.skip : describe;

function run(cmd: string[], cwd?: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function git(cwd: string, ...args: string[]) {
  const r = run(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err}`);
  return r.out.trim();
}

/** Repo whose home/ mimics the real layout, with .dsh stored as a mode-120000 entry. */
function makeRepo(root: string, { initSubmodule }: { initSubmodule: boolean }) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "home", ".config", "git"), { recursive: true });
  mkdirSync(join(repo, "home", ".local", "bin"), { recursive: true });
  mkdirSync(join(repo, "home", ".claude"), { recursive: true });
  mkdirSync(join(repo, "agents", "dsh"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "core.symlinks", "false");
  writeFileSync(join(repo, "home", ".gitconfig"), "[user]\n\tname = managed\n");
  writeFileSync(join(repo, "home", ".config", "git", "ignore"), "*.log\n");
  writeFileSync(join(repo, "home", ".local", "bin", "agent"), "#!/bin/sh\n");
  writeFileSync(join(repo, "home", ".claude", "statusline-command.sh"), "#!/bin/sh\n");
  // core.symlinks=false checkout of a symlink: a plain file holding the link text.
  writeFileSync(join(repo, "home", ".dsh"), "../agents/dsh");
  if (initSubmodule) writeFileSync(join(repo, "agents", "dsh", "README"), "dsh\n");
  git(repo, "add", "-A", "--", "home/.gitconfig", "home/.config", "home/.local", "home/.claude");
  const blob = git(repo, "hash-object", "-w", join(repo, "home", ".dsh"));
  git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},home/.dsh`);
  return repo;
}

function link(repo: string, home: string, ...extra: string[]) {
  return run(["pwsh", "-NoProfile", "-File", LINK_PS1, "-RepoRoot", repo, "-HomeDir", home, ...extra]);
}

function withTemp(fn: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "link-win-")));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isLink = (p: string) => lstatSync(p).isSymbolicLink();

describeWin("link.ps1 (Windows adoption adapter)", () => {
  test("plan mode changes nothing", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: true });
      const home = join(root, "home");
      mkdirSync(home);
      const r = link(repo, home);
      expect(r.code).toBe(0);
      expect(r.out).toContain("would-link .gitconfig");
      expect(r.out).toContain("plan only");
      expect(existsSync(join(home, ".gitconfig"))).toBe(false);
    });
  });

  test("apply links absent entries on a fresh HOME and is idempotent", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: true });
      const home = join(root, "home");
      mkdirSync(home);
      expect(link(repo, home, "-Apply").code).toBe(0);
      expect(isLink(join(home, ".gitconfig"))).toBe(true);
      expect(realpathSync(join(home, ".gitconfig"))).toBe(realpathSync(join(repo, "home", ".gitconfig")));
      // a directory unit is linked to the resolved agents/dsh checkout
      expect(isLink(join(home, ".dsh"))).toBe(true);
      expect(realpathSync(join(home, ".dsh"))).toBe(realpathSync(join(repo, "agents", "dsh")));
      // POSIX-only entries are skipped, not linked
      expect(existsSync(join(home, ".local", "bin", "agent"))).toBe(false);
      expect(existsSync(join(home, ".claude", "statusline-command.sh"))).toBe(false);

      const again = link(repo, home, "-Apply");
      expect(again.code).toBe(0);
      expect(again.out).toContain("ok         .gitconfig");
    });
  });

  test("never replaces an existing differing file; reports a conflict and keeps its data", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: true });
      const home = join(root, "home");
      mkdirSync(home);
      writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = mine\n");
      const r = link(repo, home, "-Apply");
      expect(r.code).toBe(1);
      expect(r.out).toContain("conflict   .gitconfig");
      expect(isLink(join(home, ".gitconfig"))).toBe(false);
      expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("[user]\n\tname = mine\n");
      // safe entries are still adopted
      expect(isLink(join(home, ".config", "git", "ignore"))).toBe(true);
    });
  });

  test("an identical unmanaged copy is left as is and is not a conflict", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: true });
      const home = join(root, "home");
      mkdirSync(home);
      writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = managed\n");
      const r = link(repo, home, "-Apply");
      expect(r.code).toBe(0);
      expect(r.out).toContain("identical  .gitconfig");
      expect(isLink(join(home, ".gitconfig"))).toBe(false);
    });
  });

  test("a symlink to somewhere else is a conflict and is not retargeted", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: true });
      const home = join(root, "home");
      mkdirSync(home);
      const elsewhere = join(root, "elsewhere");
      writeFileSync(elsewhere, "x");
      Bun.spawnSync(["pwsh", "-NoProfile", "-Command", `New-Item -ItemType SymbolicLink -Path '${join(home, ".gitconfig")}' -Target '${elsewhere}' | Out-Null`]);
      const r = link(repo, home, "-Apply");
      expect(r.code).toBe(1);
      expect(r.out).toContain("conflict   .gitconfig");
      expect(readlinkSync(join(home, ".gitconfig"))).toContain("elsewhere");
    });
  });

  test("an uninitialized submodule unit is skipped, not linked to an empty directory", () => {
    withTemp((root) => {
      const repo = makeRepo(root, { initSubmodule: false });
      const home = join(root, "home");
      mkdirSync(home);
      const r = link(repo, home, "-Apply");
      expect(r.code).toBe(0);
      expect(r.out).toContain("skip       .dsh");
      expect(existsSync(join(home, ".dsh"))).toBe(false);
    });
  });
});
