#!/usr/bin/env bun
/**
 * Windows-only tests for the native `agent` entry point: script/agent.cmd
 * (thin wrapper over agent.ts) and script/agent-entrypoint.ps1 (shim install,
 * conflict and shadowing detection). Covers idempotence, argv forwarding, exit
 * codes, `agent list` and `agent check`. No network, no real secrets; the
 * harness is a .cmd stub and "Grok Build" is simulated by a dummy agent.exe.
 * Real files outside the temp directory are never touched.
 */

import { describe, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(realpathSync(import.meta.path)));
const AGENT_CMD = join(REPO, "script", "agent.cmd");
const ENTRYPOINT_PS1 = join(REPO, "script", "agent-entrypoint.ps1");
const PWSH = Bun.which("pwsh") || "pwsh";

const describeWin = process.platform !== "win32" ? describe.skip : describe;

const ARGV_CAPTURE = `@echo off
> "%AGENT_TEST_OUT%" echo %*
`;

const WIN_CONFIG = `
[providers.p1]
label = "P1"
default_model = "m1"

[harnesses.win]
label = "Win"
command = "winpassthru"
adapter = "passthrough"

[routes."win.p1"]
default_model = "m1"
`;

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class Fixture {
  tmp = mkdtempSync(join(tmpdir(), "agent-entry-test-"));
  stub = join(this.tmp, "stub");
  binDir = join(this.tmp, "bin");
  shadowDir = join(this.tmp, "grok-bin");
  out = join(this.tmp, "child.txt");
  config = join(this.tmp, "config.toml");

  constructor() {
    for (const dir of [this.stub, this.binDir, this.shadowDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(this.stub, "winpassthru.cmd"), ARGV_CAPTURE);
    writeFileSync(this.config, WIN_CONFIG);
  }

  /** Windows env vars are case-insensitive: keep exactly one `Path`. */
  env(prepend: string[], extra?: Record<string, string>): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== "PATH") env[key] = value;
    }
    env["Path"] = [...prepend, process.env.Path || process.env.PATH || ""].join(";");
    return { ...env, AGENT_CONFIG: this.config, AGENT_TEST_OUT: this.out, ...extra };
  }

  cmd(cmdline: string, prepend: string[] = [this.stub]) {
    if (existsSync(this.out)) rmSync(this.out);
    return Bun.spawnSync({
      cmd: ["cmd.exe", "/d", "/c", "%AGENT_TEST_CMD%"],
      env: this.env(prepend, { AGENT_TEST_CMD: cmdline }),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  entrypoint(action: string, prepend: string[], binDir = this.binDir) {
    return Bun.spawnSync({
      cmd: [PWSH, "-NoProfile", "-File", ENTRYPOINT_PS1, action, "-BinDir", binDir],
      env: this.env(prepend),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  captured(): string {
    check(existsSync(this.out), "child harness never ran");
    return readFileSync(this.out, "utf8").replace(/\r\n/g, "\n").trim();
  }

  clean(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

function withFixture(body: (f: Fixture) => void): () => void {
  return () => {
    const f = new Fixture();
    try {
      body(f);
    } finally {
      f.clean();
    }
  };
}

const text = (b: Uint8Array | Buffer | undefined): string => (b ? b.toString() : "");

describeWin("native agent entry point (agent.cmd)", () => {
  test(
    "agent_cmd_list_and_check_succeed",
    withFixture((f) => {
      const list = f.cmd(`"${AGENT_CMD}" list`);
      check(list.exitCode === 0, `agent list failed (${list.exitCode}): ${text(list.stderr)}`);
      check(text(list.stdout).includes("win.p1"), `agent list output unexpected: ${text(list.stdout)}`);
      const chk = f.cmd(`"${AGENT_CMD}" check`);
      check(chk.exitCode === 0, `agent check failed (${chk.exitCode}): ${text(chk.stderr)}`);
      check(text(chk.stdout).includes("config OK"), `agent check output unexpected: ${text(chk.stdout)}`);
    }),
  );

  test(
    "agent_cmd_forwards_args_verbatim",
    withFixture((f) => {
      const run = f.cmd(`"${AGENT_CMD}" win p1 -- alpha "a b" "& echo injected"`);
      check(run.exitCode === 0, `run failed (${run.exitCode}): ${text(run.stderr)}`);
      check(f.captured() === `alpha "a b" "& echo injected"`, `argv mismatch: ${f.captured()}`);
      check(readFileSync(f.out, "utf8").trim().split(/\r?\n/).length === 1, "metacharacter argument leaked");
    }),
  );

  test(
    "agent_cmd_propagates_exit_codes",
    withFixture((f) => {
      const usage = f.cmd(`"${AGENT_CMD}" win --model x`);
      check(usage.exitCode === 2, `--model without provider must exit 2, got ${usage.exitCode}`);
      const unsafe = f.cmd(`"${AGENT_CMD}" win p1 -- "50%"`);
      check(unsafe.exitCode !== 0, "launcher failure must not be reported as success");
      check(!existsSync(f.out), "no harness may start for a rejected argument");
    }),
  );

  test(
    "agent_cmd_runs_from_powershell",
    withFixture((f) => {
      const ps = Bun.spawnSync({
        cmd: [PWSH, "-NoProfile", "-Command", `& '${AGENT_CMD}' list; exit $LASTEXITCODE`],
        env: f.env([f.stub]),
        stdout: "pipe",
        stderr: "pipe",
      });
      check(ps.exitCode === 0, `PowerShell run failed (${ps.exitCode}): ${text(ps.stderr)}`);
      check(text(ps.stdout).includes("win.p1"), `output unexpected: ${text(ps.stdout)}`);
    }),
  );
});

describeWin("agent-entrypoint.ps1 registration", () => {
  test(
    "install_is_idempotent_and_resolves_first",
    withFixture((f) => {
      const first = f.entrypoint("install", [f.binDir, f.stub]);
      check(first.exitCode === 0, `install failed (${first.exitCode}): ${text(first.stderr)}`);
      check(text(first.stdout).includes("created"), `expected created: ${text(first.stdout)}`);
      const shim = join(f.binDir, "agent.cmd");
      const before = readFileSync(shim, "utf8");
      check(before.includes("rem managed-by: agent-entrypoint "), "shim must carry the ownership marker");

      const second = f.entrypoint("install", [f.binDir, f.stub]);
      check(second.exitCode === 0, `second install failed: ${text(second.stderr)}`);
      check(text(second.stdout).includes("already installed"), `not idempotent: ${text(second.stdout)}`);
      check(readFileSync(shim, "utf8") === before, "idempotent install must not rewrite the shim");

      const chk = f.entrypoint("check", [f.binDir, f.stub]);
      check(chk.exitCode === 0, `check failed: ${text(chk.stderr)}`);
    }),
  );

  test(
    "installed_shim_runs_list_check_args_and_exit_code",
    withFixture((f) => {
      check(f.entrypoint("install", [f.binDir, f.stub]).exitCode === 0, "install failed");
      const list = f.cmd("agent list", [f.binDir, f.stub]);
      check(list.exitCode === 0 && text(list.stdout).includes("win.p1"), `agent list via shim: ${text(list.stderr)}`);
      const chk = f.cmd("agent check", [f.binDir, f.stub]);
      check(chk.exitCode === 0 && text(chk.stdout).includes("config OK"), `agent check via shim: ${text(chk.stderr)}`);
      const run = f.cmd(`agent win p1 -- one "two three"`, [f.binDir, f.stub]);
      check(run.exitCode === 0 && f.captured() === `one "two three"`, `argv via shim: ${f.captured()}`);
      const bad = f.cmd("agent win --model x", [f.binDir, f.stub]);
      check(bad.exitCode === 2, `exit code via shim must be 2, got ${bad.exitCode}`);
    }),
  );

  test(
    "shadowing_agent_exe_fails_and_is_never_touched",
    withFixture((f) => {
      const grok = join(f.shadowDir, "agent.exe");
      writeFileSync(grok, "not the dotfiles launcher");
      const lost = f.entrypoint("install", [f.shadowDir, f.binDir, f.stub]);
      check(lost.exitCode === 1, `shadowed install must fail, got ${lost.exitCode}`);
      check(
        text(lost.stderr).includes("shadowed") && text(lost.stderr).includes(grok),
        `no shadow report: ${text(lost.stderr)}`,
      );
      check(readFileSync(grok, "utf8") === "not the dotfiles launcher", "shadowing file was modified");
      const chk = f.entrypoint("check", [f.shadowDir, f.binDir, f.stub]);
      check(chk.exitCode === 1, "check must stay failing while shadowed");
      // Flipped directory order: the dotfiles side wins, so it passes.
      const win = f.entrypoint("check", [f.binDir, f.shadowDir, f.stub]);
      check(win.exitCode === 0, `check must pass when the shim comes first: ${text(win.stderr)}`);
    }),
  );

  test(
    "unmanaged_agent_cmd_is_a_conflict",
    withFixture((f) => {
      const shim = join(f.binDir, "agent.cmd");
      writeFileSync(shim, "@echo someone else\r\n");
      const r = f.entrypoint("install", [f.binDir, f.stub]);
      check(r.exitCode === 1, `unmanaged shim must fail, got ${r.exitCode}`);
      check(readFileSync(shim, "utf8") === "@echo someone else\r\n", "unmanaged file was overwritten");
      const rm = f.entrypoint("remove", [f.binDir, f.stub]);
      check(rm.exitCode === 1 && existsSync(shim), "remove must refuse an unmanaged file");
    }),
  );

  test(
    "remove_deletes_only_our_shim",
    withFixture((f) => {
      check(f.entrypoint("install", [f.binDir, f.stub]).exitCode === 0, "install failed");
      const rm = f.entrypoint("remove", [f.binDir, f.stub]);
      check(rm.exitCode === 0 && !existsSync(join(f.binDir, "agent.cmd")), `remove failed: ${text(rm.stderr)}`);
      check(f.entrypoint("remove", [f.binDir, f.stub]).exitCode === 0, "second remove must be a no-op");
    }),
  );
});
