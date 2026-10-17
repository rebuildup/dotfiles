#!/usr/bin/env bun
/**
 * Windows-only tests for the Windows layers of the agent launcher:
 * batch-shim (.cmd) harness launching, generated .cmd shortcuts, and the
 * script/with-secrets.ps1 PowerShell wrapper.
 *
 * These run in the windows-latest CI job; the POSIX mock suite in
 * script/agent.test.ts covers the bash-stub cases on macOS/Linux and is
 * skipped here. No network, no real secrets: harnesses and `infisical` are
 * replaced by .cmd stubs that record their environment and argv, so
 * argument boundaries, injection attempts and endpoint pinning can be
 * asserted exactly.
 */

import { describe, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(realpathSync(import.meta.path)));
const LAUNCHER = join(REPO, "script", "agent.ts");
const WITH_SECRETS_PS1 = join(REPO, "script", "with-secrets.ps1");
const INFISICAL_SH = join(REPO, "config", "infisical.sh");

const SELF_HOST_API_URL = "https://secrets.rebuildup.dev/api";

const describeWin = process.platform !== "win32" ? describe.skip : describe;

/**
 * Captures the raw command tail (`%*`) into a file. Using `%*` instead of
 * accumulating `%1`..`%n` keeps the original quoting intact, so quoted
 * metacharacters (`"& ..."`, `"(...)"`, quoted paths) stay protected when
 * cmd parses the capture line itself.
 */
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

class WinFixture {
  tmp: string;
  bindir: string;
  out: string;
  config: string;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), "agent-win-test-"));
    this.bindir = join(this.tmp, "bin");
    mkdirSync(this.bindir, { recursive: true });
    this.out = join(this.tmp, "child.txt");
    writeFileSync(join(this.bindir, "winpassthru.cmd"), ARGV_CAPTURE);
    this.config = join(this.tmp, "config.toml");
    writeFileSync(this.config, WIN_CONFIG);
  }

  env(extra?: Record<string, string>): Record<string, string | undefined> {
    return {
      ...withPath(process.env, `${this.bindir};${process.env.Path || process.env.PATH || ""}`),
      AGENT_CONFIG: this.config,
      AGENT_TEST_OUT: this.out,
      ...extra,
    };
  }

  run(args: string[], extraEnv?: Record<string, string>) {
    if (existsSync(this.out)) rmSync(this.out);
    return Bun.spawnSync({
      cmd: [process.execPath, LAUNCHER, ...args],
      env: this.env(extraEnv),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  captured(): string {
    if (!existsSync(this.out)) throw new Error("child harness never ran");
    return readFileSync(this.out, "utf8").replace(/\r\n/g, "\n").trim();
  }

  clean(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

function withWinFixture(body: (fixture: WinFixture) => void): () => void {
  return () => {
    const fixture = new WinFixture();
    try {
      body(fixture);
    } finally {
      fixture.clean();
    }
  };
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Windows env vars are case-insensitive; spreading process.env and adding a
 * second `PATH` key creates duplicate entries whose winner is undefined.
 * Replace any case variant with exactly one `Path`.
 */
function withPath(
  base: Record<string, string | undefined>,
  newPath: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase() !== "PATH") env[key] = value;
  }
  env["Path"] = newPath;
  return env;
}

/** A fake dotfiles checkout for script/with-secrets.ps1 tests. */
function makeFakeRepo(tmp: string, workspaceId: string): string {
  const repo = join(tmp, "fake-repo");
  mkdirSync(join(repo, "script"), { recursive: true });
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "script", "with-secrets.ps1"), readFileSync(WITH_SECRETS_PS1, "utf8"));
  writeFileSync(join(repo, "config", "infisical.sh"), readFileSync(INFISICAL_SH, "utf8"));
  writeFileSync(join(repo, ".infisical.json"), JSON.stringify({ workspaceId }, null, 2));
  return repo;
}

// Compiles the test double into a real infisical.exe, so the exe-only path is
// exercised with a native executable rather than a batch shim.
function buildInfisicalStub(dir: string): void {
  const built = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    join(REPO, "script", "test-fixtures", "infisical-stub.ts"),
    "--outfile",
    join(dir, "infisical.exe"),
  ]);
  check(built.exitCode === 0, `failed to build infisical stub: ${built.stderr.toString()}`);
}

const PWSH = Bun.which("pwsh") || "pwsh";

function runPs1(script: string, args: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync({
    cmd: [PWSH, "-NoProfile", "-File", script, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describeWin("agent launcher Windows layers", () => {
  test("test_windows_batch_shim_argv_boundaries", () => {
    const fixture = new WinFixture();
    try {
      // Spaces, cmd metacharacters and an injection attempt must arrive as
      // single literal arguments — the shim must not re-parse them.
      const result = fixture.run(["win", "p1", "--", "alpha", "a b", "& echo injected", "(x)", "end"]);
      check(result.exitCode === 0, `run failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
      // The launcher quotes metacharacter args itself; %* preserves that
      // exact command tail, so the expected string is deterministic.
      check(
        fixture.captured() === `alpha "a b" "& echo injected" "(x)" end`,
        `unexpected argv capture: ${fixture.captured()}`,
      );
      // exactly one line: "& echo injected" was quoted, never executed
      check(
        readFileSync(fixture.out, "utf8").trim().split(/\r?\n/).length === 1,
        "metacharacter argument leaked into extra command output",
      );
    } finally {
      fixture.clean();
    }
  });

  test("test_windows_native_provider_omitted", () => {
    const fixture = new WinFixture();
    try {
      const result = fixture.run(["win", "-p", "hi"]);
      check(result.exitCode === 0, `native run failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
      check(fixture.captured() === `-p hi`, `native argv mismatch: ${fixture.captured()}`);
      // model flags still need a provider route, even on Windows
      const model = fixture.run(["win", "--model", "x"]);
      check(model.exitCode === 2, `--model without provider must exit 2, got ${model.exitCode}`);
      check(model.stderr.toString().includes("requires a provider"), model.stderr.toString());
    } finally {
      fixture.clean();
    }
  });

  test("test_windows_batch_shim_rejects_unsafe_args", () => {
    const fixture = new WinFixture();
    try {
      for (const bad of ["%PATH%", 'say "hi"']) {
        const result = fixture.run(["win", "p1", "--", bad]);
        check(
          result.exitCode === 1,
          `argument ${bad} must be rejected, got exit ${result.exitCode}`,
        );
        check(
          result.stderr.toString().includes("cannot be passed safely"),
          `expected fail-closed message for ${bad}, got: ${result.stderr.toString()}`,
        );
        check(!existsSync(fixture.out), "no harness process may start for a rejected argument");
      }
    } finally {
      fixture.clean();
    }
  });

  test("test_windows_shortcut_cmd_create_and_exec", () => {
    const fixture = new WinFixture();
    const links = join(fixture.tmp, "links");
    try {
      const create = fixture.run(["shortcuts", "create"], { AGENT_BIN_DIR: links });
      check(create.exitCode === 0, `shortcuts create failed: ${create.stderr.toString()}`);

      const link = join(links, "win-p1.cmd");
      check(existsSync(link), `generated .cmd missing: ${link}`);
      const content = readFileSync(link, "utf8");
      check(
        content.includes("rem managed-by: agent-launcher ") && content.includes(realpathSync(LAUNCHER)),
        `generated .cmd must carry the ownership marker, got: ${content}`,
      );
      check(content.includes("win-p1 %*"), `generated .cmd must pass args verbatim, got: ${content}`);

      // Execute the generated entry point through cmd.exe; the route name in
      // argv must dispatch to the stub harness with intact arguments.
      if (existsSync(fixture.out)) rmSync(fixture.out);
      // cmd's double-quote idiom only applies to a raw /c operand; through
      // env-var expansion the plain quoted form is what parses correctly.
      const runEnv = fixture.env({ AGENT_TEST_CMD: `"${link}" one "two three"` });
      const run = Bun.spawnSync({
        cmd: ["cmd.exe", "/d", "/c", "%AGENT_TEST_CMD%"],
        env: runEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      check(run.exitCode === 0, `generated .cmd failed (exit ${run.exitCode}): ${run.stderr.toString()}`);
      check(
        fixture.captured() === `one "two three"`,
        `shortcut exec argv mismatch: ${fixture.captured()}`,
      );
    } finally {
      fixture.clean();
    }
  });

  test("test_windows_with_secrets_ps1_pins_api_url_and_passes_args", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-ps1-test-"));
    try {
      const realWorkspace = JSON.parse(readFileSync(join(REPO, ".infisical.json"), "utf8")).workspaceId;
      const repo = makeFakeRepo(tmp, realWorkspace);
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      const capture = join(tmp, "infisical-capture.json");
      buildInfisicalStub(bin);

      const result = runPs1(
        join(repo, "script", "with-secrets.ps1"),
        ["echo", "hello", "two words", "& echo injected"],
        {
          ...withPath(process.env, `${bin};${process.env.Path || process.env.PATH || ""}`),
          CAPTURE_FILE: capture,
          // ambient Cloud URL must be overridden, never used
          INFISICAL_API_URL: "https://cloud.infisical.com/api",
        },
      );
      check(result.exitCode === 0, `wrapper failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
      const captured = JSON.parse(readFileSync(capture, "utf8")) as { url: string; argv: string[] };
      check(captured.url === SELF_HOST_API_URL, `wrapper must pin the self-hosted API URL, got: ${captured.url}`);
      check(
        JSON.stringify(captured.argv) ===
          JSON.stringify([
            "run",
            `--projectId=${realWorkspace}`,
            "--env=dev",
            `--project-config-dir=${repo}`,
            "--",
            "echo",
            "hello",
            "two words",
            "& echo injected",
          ]),
        `infisical argv mismatch: ${JSON.stringify(captured.argv)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("test_windows_with_secrets_ps1_rejects_cmd_and_bat_shims", () => {
    for (const shim of ["infisical.cmd", "infisical.bat"]) {
      const tmp = mkdtempSync(join(tmpdir(), "agent-ps1-test-"));
      try {
        const realWorkspace = JSON.parse(readFileSync(join(REPO, ".infisical.json"), "utf8")).workspaceId;
        const repo = makeFakeRepo(tmp, realWorkspace);
        const bin = join(tmp, "bin");
        mkdirSync(bin, { recursive: true });
        const capture = join(tmp, "infisical-capture.json");
        writeFileSync(join(bin, shim), `@echo off\r\n> "%CAPTURE_FILE%" echo ran\r\n`);

        const result = runPs1(join(repo, "script", "with-secrets.ps1"), ["echo", "x"], {
          ...withPath(process.env, `${bin};${process.env.Path || process.env.PATH || ""}`),
          CAPTURE_FILE: capture,
        });
        check(result.exitCode === 1, `${shim} must fail closed, got exit ${result.exitCode}`);
        check(
          result.stderr.toString().includes("must resolve to infisical.exe"),
          `${shim}: expected exe-only error, got: ${result.stderr.toString()}`,
        );
        check(!existsSync(capture), `${shim} must never be executed`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  test("test_windows_with_secrets_ps1_rejects_workspace_mismatch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-ps1-test-"));
    try {
      const repo = makeFakeRepo(tmp, "00000000-0000-0000-0000-000000000000");
      const result = runPs1(join(repo, "script", "with-secrets.ps1"), ["echo", "x"], {
        ...process.env,
      });
      check(result.exitCode === 1, `mismatched workspaceId must fail, got exit ${result.exitCode}`);
      check(
        result.stderr.toString().includes("does not match"),
        `expected strict workspaceId error, got: ${result.stderr.toString()}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("test_windows_with_secrets_ps1_requires_infisical", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-ps1-test-"));
    try {
      const realWorkspace = JSON.parse(readFileSync(join(REPO, ".infisical.json"), "utf8")).workspaceId;
      const repo = makeFakeRepo(tmp, realWorkspace);
      const result = runPs1(join(repo, "script", "with-secrets.ps1"), ["echo", "x"], {
        ...withPath(process.env, `${process.env.SystemRoot}\\System32`),
      });
      check(result.exitCode === 1, `missing infisical must fail, got exit ${result.exitCode}`);
      check(
        result.stderr.toString().includes("missing required command: infisical"),
        `expected missing-infisical error, got: ${result.stderr.toString()}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
