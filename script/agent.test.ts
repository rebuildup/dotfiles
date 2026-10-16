#!/usr/bin/env bun
/**
 * Mock tests for script/agent.ts (Bun port of script/test-agent).
 *
 * No network, no real secrets: the harness binaries are replaced by stubs
 * that dump their argv and environment, and script/with-secrets is replaced
 * by a stub that injects a fake Infisical `dev` secret set.
 *
 * Run: bun test script/agent.test.ts
 */

import { test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(realpathSync(import.meta.path)));
const LAUNCHER = join(REPO, "script", "agent.ts");
const REAL_CONFIG = join(REPO, "config", "agents.toml");

// shortcut names derived from the routes, exactly like the launcher does
const REAL_SHORTCUTS = Object.keys(
  (Bun.TOML.parse(readFileSync(REAL_CONFIG, "utf8")) as { routes: Record<string, unknown> })
    .routes,
)
  .map((key) => {
    const dot = key.indexOf(".");
    return `${key.slice(0, dot)}-${key.slice(dot + 1)}`;
  })
  .sort();

const HARNESSES = ["claude", "opencode", "pi", "dsh"];

const FAKE_HARNESS = `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'ARGV\\n'
  for arg in "$@"; do printf '%s\\n' "$arg"; done
  printf 'ARGV-END\\n'
  env | sort
} > "\${AGENT_TEST_OUT:?}"
`;

// Simulates `infisical run --env dev`: injects every secret of the project.
const FAKE_WITH_SECRETS = `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${AGENT_TEST_MARKER:-}" ]]; then
  : > "$AGENT_TEST_MARKER"
fi
if [[ -n "\${AGENT_TEST_WRAPPER_ARGV:-}" ]]; then
  printf '%s\\n' "$@" > "$AGENT_TEST_WRAPPER_ARGV"
fi
export FAKE_INFISICAL_INJECTED=yes
export DEEPSEEK_API_KEY=secret-deepseek
export OPENROUTER_API_KEY=secret-openrouter
export OPENCODE_API_KEY=secret-zen
export MINIMAX_M_PLAN_KEY=secret-minimax-plan
export MINIMAX_TOKEN_PLAN_KEY=secret-minimax-legacy
export MIMO_API_KEY=secret-mimo
export ANTHROPIC_AUTH_TOKEN=secret-anthropic
export INFISICAL_TOKEN=secret-infisical
exec "$@"
`;

// Same, but the DeepSeek secret is absent (rotated/never provisioned).
const FAKE_WITH_SECRETS_NO_DEEPSEEK = FAKE_WITH_SECRETS.replace(
  "export DEEPSEEK_API_KEY=secret-deepseek\n",
  "",
);

const PRECEDENCE_CONFIG = `
[defaults]
drop_env = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]

[providers.p1]
label = "P1"
base_url = "https://p1.example/api"
secret = "DEEPSEEK_API_KEY"
env = "DEEPSEEK_API_KEY"
default_model = "provider-model"
models = ["provider-model", "route-model", "cli-model"]

[providers.p2]
label = "P2"
secret = "CUSTOMP_API_KEY"
env = "CUSTOMP_API_KEY"
default_model = "provider-model"
models = ["provider-model"]

[harnesses.h1]
label = "H1"
command = "claude"
adapter = "anthropic"

[harnesses.h1.env]
base_url = "ANTHROPIC_BASE_URL"
auth_token = "ANTHROPIC_AUTH_TOKEN"
api_key = "ANTHROPIC_API_KEY"
model = "ANTHROPIC_MODEL"
small_fast_model = "ANTHROPIC_SMALL_FAST_MODEL"
default_opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
default_sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
default_haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"

[routes."h1.p1"]
default_model = "route-model"
`;

const GHOST_CONFIG = `
[providers.p1]
label = "P1"
secret = "DEEPSEEK_API_KEY"
env = "DEEPSEEK_API_KEY"
default_model = "provider-model"
models = ["provider-model"]

[harnesses.ghost]
label = "Ghost"
command = "definitely-not-installed-harness"
adapter = "passthrough"

[routes."ghost.p1"]
`;

const REQUIRE_CONFIG = `
[providers.p1]
label = "P1"
base_url = "https://p1.example/api"
secret = "DEEPSEEK_API_KEY"
env = "DEEPSEEK_API_KEY"
require_model = true
models = ["m1", "m2"]

[harnesses.h1]
label = "H1"
command = "claude"
adapter = "anthropic"
[harnesses.h1.env]
base_url = "ANTHROPIC_BASE_URL"
auth_token = "ANTHROPIC_AUTH_TOKEN"
api_key = "ANTHROPIC_API_KEY"
model = "ANTHROPIC_MODEL"
small_fast_model = "ANTHROPIC_SMALL_FAST_MODEL"
default_opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
default_sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
default_haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"

[routes."h1.p1"]
`;

interface RunOptions {
  env?: Record<string, string>;
  config?: string;
}

class Fixture {
  tmp: string;
  bindir: string;
  out: string;
  marker: string;
  wrapper_argv: string;
  wrapper: string;

  constructor() {
    this.tmp = mkdtempSync(join(tmpdir(), "agent-launcher-test-"));
    this.bindir = join(this.tmp, "bin");
    mkdirSync(this.bindir);
    this.out = join(this.tmp, "child.env");
    this.marker = join(this.tmp, "wrapper.ran");
    this.wrapper_argv = join(this.tmp, "wrapper.argv");
    this.wrapper = join(this.tmp, "with-secrets");
    this.writeWrapper(FAKE_WITH_SECRETS);
    for (const harness of HARNESSES) {
      const path = join(this.bindir, harness);
      writeFileSync(path, FAKE_HARNESS);
      chmodSync(path, 0o755);
    }
  }

  writeWrapper(content: string): void {
    writeFileSync(this.wrapper, content);
    chmodSync(this.wrapper, 0o755);
  }

  baseEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {
      PATH: `${this.bindir}:${process.env.PATH || "/usr/bin:/bin"}`,
      HOME: process.env.HOME || this.tmp,
      AGENT_WITH_SECRETS: this.wrapper,
      AGENT_TEST_OUT: this.out,
      AGENT_TEST_MARKER: this.marker,
      AGENT_TEST_WRAPPER_ARGV: this.wrapper_argv,
    };
    if (extra) {
      Object.assign(env, extra);
    }
    return env;
  }

  private clearDumps(): void {
    for (const path of [this.out, this.marker, this.wrapper_argv]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
  }

  private spawn(cmd: string[], options: RunOptions) {
    this.clearDumps();
    const env = this.baseEnv(options.env);
    if (options.config !== undefined) {
      env["AGENT_CONFIG"] = options.config;
    }
    return Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
  }

  run(args: string[], options: RunOptions = {}) {
    return this.spawn([process.execPath, LAUNCHER, ...args], options);
  }

  /** Invoke the launcher through a `<harness>-<provider>` symlink. */
  runShortcut(name: string, args: string[], options: RunOptions = {}) {
    const link = join(this.bindir, name);
    let linkExists = false;
    try {
      lstatSync(link);
      linkExists = true;
    } catch {
      linkExists = false;
    }
    if (!linkExists) {
      symlinkSync(LAUNCHER, link);
    }
    // Bun resolves a symlinked argv[1], so the launcher is started through
    // the interpreter and recovers the invoked name from the kernel argv.
    return this.spawn([process.execPath, link, ...args], options);
  }

  /** Parse the stub harness dump: [argv, env]. */
  child(): [string[], Record<string, string>] {
    if (!existsSync(this.out)) {
      throw new Error("child harness never ran");
    }
    const lines = readFileSync(this.out, "utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length === 0 || lines[0] !== "ARGV") {
      throw new Error(`unexpected dump header: ${JSON.stringify(lines.slice(0, 1))}`);
    }
    const end = lines.indexOf("ARGV-END");
    if (end === -1) {
      throw new Error("dump misses ARGV-END");
    }
    const argv = lines.slice(1, end);
    const env: Record<string, string> = {};
    for (const line of lines.slice(end + 1)) {
      const eq = line.indexOf("=");
      const name = eq === -1 ? line : line.slice(0, eq);
      const value = eq === -1 ? "" : line.slice(eq + 1);
      env[name] = value;
    }
    return [argv, env];
  }

  clean(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

function check(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** Run one test body with a fresh fixture, cleaning up afterwards. */
function withFixture(body: (fixture: Fixture) => void): () => void {
  return () => {
    const fixture = new Fixture();
    try {
      body(fixture);
    } finally {
      fixture.clean();
    }
  };
}

test(
  "test_config_valid",
  withFixture((fixture) => {
    const result = fixture.run(["check"], { config: REAL_CONFIG });
    check(result.exitCode === 0, `check failed: ${result.stderr.toString()}`);
    check(result.stdout.toString().includes("config OK"), result.stdout.toString());
    check(
      result.stdout.toString().includes(REAL_CONFIG) ||
        result.stdout.toString().includes("config OK"),
      result.stdout.toString(),
    );
  }),
);

test(
  "test_help",
  withFixture((fixture) => {
    for (const args of [["help"], ["--help"], ["-h"], ["claude", "openrouter", "--help"]]) {
      const result = fixture.run(args, { config: REAL_CONFIG });
      check(
        result.exitCode === 0,
        `${args.join(" ")} -> ${result.exitCode}: ${result.stderr.toString()}`,
      );
      check(result.stdout.toString().includes("usage:"), `${args.join(" ")}: no usage in stdout`);
    }
    const result = fixture.run([], { config: REAL_CONFIG });
    check(result.exitCode === 2, "bare `agent` must exit 2");
    check(result.stderr.toString().includes("usage:"), "bare `agent` must print usage on stderr");
  }),
);

test(
  "test_list",
  withFixture((fixture) => {
    const result = fixture.run(["list"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const stdout = result.stdout.toString();
    for (const route of [
      "claude.openrouter",
      "claude.deepseek",
      "claude.minimax",
      "opencode.zen",
      "pi.deepseek",
      "dsh.deepseek",
    ]) {
      check(stdout.includes(route), `list misses ${route}: ${stdout}`);
    }
    check(
      !stdout.includes("--model required"),
      "every configured route must resolve a default model",
    );
    check(stdout.includes("MiniMax-M2.5"), "minimax default missing");
    check(stdout.includes("mimo-v2.6-flash-free"), "zen default missing");
    check(stdout.includes("opencode-zen"), "shortcut names must be listed");
  }),
);

test(
  "test_models",
  withFixture((fixture) => {
    let result = fixture.run(["models", "deepseek"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    let stdout = result.stdout.toString();
    check(stdout.includes("DEEPSEEK_API_KEY"), stdout);
    check(stdout.includes("deepseek-flash"), stdout);
    check(stdout.includes("https://api.deepseek.com/anthropic"), stdout);
    check(stdout.includes("routes:"), stdout);

    result = fixture.run(["models", "zen"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    check(result.stdout.toString().includes("opencode/mimo-v2.6-flash-free"), result.stdout.toString());

    result = fixture.run(["models", "nope"], { config: REAL_CONFIG });
    check(result.exitCode === 2, "unknown provider must exit 2");
    check(result.stderr.toString().includes("unknown provider"), result.stderr.toString());
  }),
);

test(
  "test_unknown_selection",
  withFixture((fixture) => {
    const cases: Array<[string[], string]> = [
      [["bogus", "zen"], "unknown harness"],
      [["claude", "bogus"], "unknown provider"],
      [["dsh", "openrouter"], "available providers for 'dsh'"],
      [["claude"], "missing provider"],
      [["claude", "openrouter", "stray"], "unexpected argument"],
      [["claude", "openrouter", "--model"], "requires a value"],
    ];
    for (const [args, needle] of cases) {
      const result = fixture.run(args, { config: REAL_CONFIG });
      check(
        result.exitCode === 2,
        `${args.join(" ")} -> ${result.exitCode}: ${result.stderr.toString()}`,
      );
      check(
        result.stderr.toString().includes(needle),
        `${args.join(" ")}: expected '${needle}' in '${result.stderr.toString()}'`,
      );
    }
  }),
);

test(
  "test_unknown_model",
  withFixture((fixture) => {
    const result = fixture.run(["claude", "openrouter", "--model", "gpt-expensive"], {
      config: REAL_CONFIG,
    });
    check(result.exitCode === 2, result.stderr.toString());
    check(
      (result.stdout.toString() + result.stderr.toString()).includes("unknown model"),
      result.stderr.toString(),
    );
    // route-level model list overrides the provider list (claude.deepseek)
    const result2 = fixture.run(["claude", "deepseek", "--model", "deepseek-v4-pro"], {
      config: REAL_CONFIG,
    });
    check(result2.exitCode === 2, "route model list must be enforced");
    check(result2.stderr.toString().includes("unknown model"), result2.stderr.toString());
  }),
);

test(
  "test_minimax_default_model",
  withFixture((fixture) => {
    // no --model: the verified default applies (fail closed is kept by the
    // models list — unknown ids are rejected before a process starts)
    const result = fixture.run(["claude", "minimax"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const [argv, env] = fixture.child();
    check(argv.length === 0, `argv ${JSON.stringify(argv)}`);
    check(env["ANTHROPIC_BASE_URL"] === "https://api.minimax.io/anthropic", JSON.stringify(env));
    check(env["ANTHROPIC_MODEL"] === "MiniMax-M2.5", JSON.stringify(env));
    check(env["ANTHROPIC_DEFAULT_OPUS_MODEL"] === "MiniMax-M2.5", JSON.stringify(env));
    check(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] === "MiniMax-M2.5", JSON.stringify(env));
    check(env["ANTHROPIC_SMALL_FAST_MODEL"] === "MiniMax-M2.5", JSON.stringify(env));
    // secret rename: Infisical MINIMAX_M_PLAN_KEY -> harness MINIMAX_API_KEY
    check(env["MINIMAX_API_KEY"] === "secret-minimax-plan", env["MINIMAX_API_KEY"]);
    check(
      env["ANTHROPIC_AUTH_TOKEN"] === "secret-minimax-plan",
      `auth token was '${env["ANTHROPIC_AUTH_TOKEN"]}'`,
    );
    // ... but no other provider's secret reaches the child
    for (const leak of [
      "DEEPSEEK_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENCODE_API_KEY",
      "MIMO_API_KEY",
      "INFISICAL_TOKEN",
      "FAKE_INFISICAL_INJECTED",
      "MINIMAX_TOKEN_PLAN_KEY",
    ]) {
      check(!(leak in env), `secret leaked to child: ${leak}`);
    }
    check(existsSync(fixture.marker), "with-secrets wrapper was not used");

    // --model still overrides the default for one process
    const result2 = fixture.run(["claude", "minimax", "--model", "MiniMax-M3"], {
      config: REAL_CONFIG,
    });
    check(result2.exitCode === 0, result2.stderr.toString());
    const [, env2] = fixture.child();
    check(env2["ANTHROPIC_MODEL"] === "MiniMax-M3", JSON.stringify(env2));

    // ids outside the model list still fail closed
    const result3 = fixture.run(["claude", "minimax", "--model", "MiniMax-not-a-model"], {
      config: REAL_CONFIG,
    });
    check(result3.exitCode === 2, "unknown minimax model must exit 2");
    check(result3.stderr.toString().includes("unknown model"), result3.stderr.toString());
  }),
);

test(
  "test_require_model_fail_closed",
  withFixture((fixture) => {
    const config = join(fixture.tmp, "require.toml");
    writeFileSync(config, REQUIRE_CONFIG);
    const result = fixture.run(["h1", "p1"], { config });
    check(result.exitCode === 2, `expected 2, got ${result.exitCode}: ${result.stderr.toString()}`);
    check(result.stderr.toString().includes("requires an explicit model"), result.stderr.toString());
    check(!existsSync(fixture.marker), "credentials must not be fetched first");

    const result2 = fixture.run(["h1", "p1", "--model", "m2"], { config });
    check(result2.exitCode === 0, result2.stderr.toString());
    const [, env] = fixture.child();
    check(env["ANTHROPIC_MODEL"] === "m2", JSON.stringify(env));
  }),
);

test(
  "test_shortcut_equivalence",
  withFixture((fixture) => {
    // `opencode-zen` must start exactly what `agent opencode zen` starts.
    const result = fixture.run(["opencode", "zen"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const [refArgv, refEnv] = fixture.child();

    const result2 = fixture.runShortcut("opencode-zen", [], { config: REAL_CONFIG });
    check(result2.exitCode === 0, result2.stderr.toString());
    const [argv, env] = fixture.child();
    expect(argv, `argv ${JSON.stringify(argv)} != ${JSON.stringify(refArgv)}`).toEqual(refArgv);
    expect(env, "shortcut child env must equal the agent-form env").toEqual(refEnv);
    check(
      (env["OPENCODE_CONFIG_CONTENT"] ?? "").endsWith('"opencode/mimo-v2.6-flash-free"}'),
      `model selection differs: ${env["OPENCODE_CONFIG_CONTENT"]}`,
    );
  }),
);

test(
  "test_shortcut_args_and_agent_model",
  withFixture((fixture) => {
    const result = fixture.runShortcut("claude-deepseek", ["-p", "hi"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    let [argv, env] = fixture.child();
    expect(argv, `argv ${JSON.stringify(argv)}`).toEqual(["-p", "hi"]);
    check(env["ANTHROPIC_MODEL"] === "deepseek-flash", JSON.stringify(env));

    for (const modelArgs of [
      ["--agent-model", "deepseek-v4-pro", "-p", "hi"],
      ["--agent-model=deepseek-v4-pro", "-p", "hi"],
    ]) {
      const result2 = fixture.runShortcut("opencode-deepseek", modelArgs, {
        config: REAL_CONFIG,
      });
      check(result2.exitCode === 0, result2.stderr.toString());
      [argv, env] = fixture.child();
      expect(argv, `launcher flag leaked into argv: ${JSON.stringify(argv)}`).toEqual([
        "--standalone",
        "-p",
        "hi",
      ]);
      check(
        (env["OPENCODE_CONFIG_CONTENT"] ?? "").includes("deepseek/deepseek-v4-pro"),
        env["OPENCODE_CONFIG_CONTENT"],
      );
    }

    const result3 = fixture.runShortcut("claude-deepseek", ["--agent-model"], {
      config: REAL_CONFIG,
    });
    check(result3.exitCode === 2, "missing value must fail");
    check(result3.stderr.toString().includes("requires a value"), result3.stderr.toString());

    // a leading '--' is tolerated (habit from the agent form)
    const result4 = fixture.runShortcut("claude-deepseek", ["--", "-p", "hi"], {
      config: REAL_CONFIG,
    });
    check(result4.exitCode === 0, result4.stderr.toString());
    const [argv4] = fixture.child();
    expect(argv4, `argv ${JSON.stringify(argv4)}`).toEqual(["-p", "hi"]);
  }),
);

test(
  "test_shortcut_forbidden_args",
  withFixture((fixture) => {
    const cases = [
      ["--model", "deepseek-v4-pro"],
      ["-m", "deepseek-v4-pro"],
      ["--provider", "openrouter"],
      ["--api-key=sk-x"],
      ["--fallback-model=x"],
    ];
    for (const args of cases) {
      const result = fixture.runShortcut("opencode-zen", args, { config: REAL_CONFIG });
      check(
        result.exitCode === 2,
        `${args.join(" ")} -> ${result.exitCode}: ${result.stderr.toString()}`,
      );
      check(
        result.stderr.toString().includes("not allowed"),
        `${args.join(" ")}: ${result.stderr.toString()}`,
      );
    }
    check(!existsSync(fixture.marker), "credentials must not be fetched");

    // passthrough harnesses keep rejecting launcher-owned model selection
    const result = fixture.runShortcut("dsh-deepseek", ["--agent-model", "x"], {
      config: REAL_CONFIG,
    });
    check(result.exitCode === 2, result.stderr.toString());
    check(result.stderr.toString().includes("does not accept"), result.stderr.toString());
  }),
);

test(
  "test_shortcut_unknown_name",
  withFixture((fixture) => {
    const result = fixture.runShortcut("claude-zen", [], { config: REAL_CONFIG });
    check(result.exitCode === 2, `${result.exitCode}: ${result.stderr.toString()}`);
    check(result.stderr.toString().includes("unknown shortcut"), result.stderr.toString());
    check(result.stderr.toString().includes("opencode-zen"), "known shortcuts must be listed");
    check(!existsSync(fixture.marker), "credentials must not be fetched");

    const result2 = fixture.runShortcut("totally-bogus", [], { config: REAL_CONFIG });
    check(result2.exitCode === 2, result2.stderr.toString());

    // subcommand names are not shortcuts
    const result3 = fixture.runShortcut("list", [], { config: REAL_CONFIG });
    check(result3.exitCode === 2, "agent subcommands must not be shortcuts");
  }),
);

test(
  "test_shortcuts_link_management",
  withFixture((fixture) => {
    const links = join(fixture.tmp, "links");
    const env = { AGENT_BIN_DIR: links };

    const listed = fixture.run(["shortcuts"], { env, config: REAL_CONFIG });
    check(listed.exitCode === 0, listed.stderr.toString());
    const listedOut = listed.stdout.toString();
    for (const name of REAL_SHORTCUTS) {
      check(listedOut.includes(name), `shortcuts list misses ${name}`);
    }
    check(!listedOut.includes("claude-zen"), "non-route must not be listed");
    check(listedOut.includes("missing"), listedOut);

    const checked = fixture.run(["shortcuts", "check"], { env, config: REAL_CONFIG });
    check(checked.exitCode === 1, "check must fail before create");

    // a native harness entry in the same directory is never touched
    mkdirSync(links);
    const native = join(links, "claude");
    symlinkSync("/bin/ls", native);

    const created = fixture.run(["shortcuts", "create"], { env, config: REAL_CONFIG });
    check(created.exitCode === 0, created.stderr.toString());
    check(
      lstatSync(native).isSymbolicLink() && realpathSync(native) === realpathSync("/bin/ls"),
      "native claude entry must be untouched",
    );
    for (const name of REAL_SHORTCUTS) {
      const path = join(links, name);
      check(lstatSync(path).isSymbolicLink(), `${name} was not created`);
      check(realpathSync(path) === realpathSync(LAUNCHER), `${name} points elsewhere`);
    }
    check(!existsSync(join(links, "claude-zen")), "non-route shortcut must not be created");

    // re-running is safe (idempotent)
    const createdAgain = fixture.run(["shortcuts", "create"], { env, config: REAL_CONFIG });
    check(createdAgain.exitCode === 0, createdAgain.stderr.toString());
    check(createdAgain.stdout.toString().includes("0 created"), createdAgain.stdout.toString());
    const checkedAgain = fixture.run(["shortcuts", "check"], { env, config: REAL_CONFIG });
    check(checkedAgain.exitCode === 0, checkedAgain.stderr.toString());

    // an unmanaged file is never overwritten
    const victim = join(links, "pi-openrouter");
    unlinkSync(victim);
    writeFileSync(victim, "not ours\n");
    const conflicting = fixture.run(["shortcuts", "create"], { env, config: REAL_CONFIG });
    check(conflicting.exitCode === 1, conflicting.stderr.toString());
    check(
      conflicting.stderr.toString().includes("refusing to overwrite"),
      conflicting.stderr.toString(),
    );
    check(readFileSync(victim, "utf8") === "not ours\n", "conflicting file must be untouched");
    const checkedConflict = fixture.run(["shortcuts", "check"], { env, config: REAL_CONFIG });
    check(checkedConflict.exitCode === 1, "check must fail on a conflict");

    // remove takes back only what the launcher owns
    unlinkSync(victim);
    const foreign = join(links, "opencode-deepseek");
    unlinkSync(foreign);
    symlinkSync("/bin/ls", foreign);
    const removed = fixture.run(["shortcuts", "remove"], { env, config: REAL_CONFIG });
    check(removed.exitCode === 0, removed.stderr.toString());
    check(
      lstatSync(foreign).isSymbolicLink() && realpathSync(foreign) === realpathSync("/bin/ls"),
      "foreign symlink must survive remove",
    );
    check(lstatSync(native).isSymbolicLink(), "native entry must survive remove");
    for (const name of REAL_SHORTCUTS) {
      if (name === "opencode-deepseek") {
        continue;
      }
      check(!existsSync(join(links, name)), `${name} must be removed`);
    }
    const checkedAfterRemove = fixture.run(["shortcuts", "check"], { env, config: REAL_CONFIG });
    check(checkedAfterRemove.exitCode === 1, "check must fail after remove");

    const frobnicated = fixture.run(["shortcuts", "frobnicate"], { env, config: REAL_CONFIG });
    check(frobnicated.exitCode === 2, frobnicated.stderr.toString());
  }),
);

test(
  "test_native_harness_not_wrapped",
  withFixture((fixture) => {
    // Plain `claude`/`opencode` never go through the launcher.
    const env = fixture.baseEnv();
    const result = Bun.spawnSync({
      cmd: [join(fixture.bindir, "claude"), "--version"],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    check(result.exitCode === 0, result.stderr.toString());
    const [, childEnv] = fixture.child();
    check(
      !("ANTHROPIC_MODEL" in childEnv),
      "native claude must not receive route env",
    );
    check(
      !("ANTHROPIC_BASE_URL" in childEnv),
      "native claude must not be redirected",
    );
    check(!existsSync(fixture.marker), "with-secrets must not run for a native command");
  }),
);

test(
  "test_claude_deepseek_filters_preset_secrets",
  withFixture((fixture) => {
    const result = fixture.run(["claude", "deepseek"], {
      env: { OPENROUTER_API_KEY: "preset-openrouter" },
      config: REAL_CONFIG,
    });
    check(result.exitCode === 0, result.stderr.toString());
    const [argv, env] = fixture.child();
    expect(argv, JSON.stringify(argv)).toEqual([]);
    check(env["ANTHROPIC_BASE_URL"] === "https://api.deepseek.com/anthropic", JSON.stringify(env));
    check(env["ANTHROPIC_MODEL"] === "deepseek-flash", JSON.stringify(env));
    check(
      env["ANTHROPIC_AUTH_TOKEN"] === "secret-deepseek",
      `auth token was '${env["ANTHROPIC_AUTH_TOKEN"]}'`,
    );
    check(!("ANTHROPIC_API_KEY" in env), "ANTHROPIC_API_KEY must be cleared");
    check(env["DEEPSEEK_API_KEY"] === "secret-deepseek", JSON.stringify(env));
    check(
      !("OPENROUTER_API_KEY" in env),
      "pre-existing other-provider secret must be dropped",
    );
    check(!("OPENCODE_API_KEY" in env), "injected zen secret must be dropped");
    check(existsSync(fixture.marker), "with-secrets wrapper was not used");
  }),
);

test(
  "test_env_short_circuits_injection",
  withFixture((fixture) => {
    const result = fixture.run(["claude", "deepseek"], {
      env: { DEEPSEEK_API_KEY: "already-here" },
      config: REAL_CONFIG,
    });
    check(result.exitCode === 0, result.stderr.toString());
    const [, env] = fixture.child();
    check(env["ANTHROPIC_AUTH_TOKEN"] === "already-here", JSON.stringify(env));
    check(
      !existsSync(fixture.marker),
      "with-secrets must be skipped when the credential is already set",
    );
  }),
);

test(
  "test_missing_secret_fails",
  withFixture((fixture) => {
    fixture.writeWrapper(FAKE_WITH_SECRETS_NO_DEEPSEEK);
    const result = fixture.run(["claude", "deepseek"], { config: REAL_CONFIG });
    check(result.exitCode === 1, `expected exit 1, got ${result.exitCode}`);
    check(result.stderr.toString().includes("DEEPSEEK_API_KEY"), result.stderr.toString());
    check(result.stderr.toString().includes("Infisical"), result.stderr.toString());
    check(!existsSync(fixture.out), "harness must not start without credentials");
  }),
);

test(
  "test_opencode_zen",
  withFixture((fixture) => {
    const result = fixture.run(["opencode", "zen"], {
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
      config: REAL_CONFIG,
    });
    check(result.exitCode === 0, result.stderr.toString());
    let [argv, env] = fixture.child();
    expect(argv, JSON.stringify(argv)).toEqual(["--standalone"]);
    check(env["OPENCODE_API_KEY"] === "secret-zen", JSON.stringify(env));
    const content = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]) as Record<string, unknown>;
    check(content["model"] === "opencode/mimo-v2.6-flash-free", JSON.stringify(content));
    check(content["permission"] === "allow", "existing inline config must merge");
    // the wrapper stage must never see the caller's inline config (it may
    // contain provider apiKey values): only the model id crosses argv
    check(existsSync(fixture.marker), "with-secrets wrapper was not used");
    const wrapperText = existsSync(fixture.wrapper_argv)
      ? readFileSync(fixture.wrapper_argv, "utf8")
      : "";
    check(
      !wrapperText.includes('"permission"'),
      `caller inline config leaked into wrapper argv: ${wrapperText.slice(0, 200)}`,
    );

    const result2 = fixture.run(["opencode", "zen", "--", "run", "hello world"], {
      config: REAL_CONFIG,
    });
    check(result2.exitCode === 0, result2.stderr.toString());
    const [argv2, env2] = fixture.child();
    expect(argv2, JSON.stringify(argv2)).toEqual(["run", "--standalone", "hello world"]);
    check(
      (JSON.parse(env2["OPENCODE_CONFIG_CONTENT"]) as Record<string, unknown>)["model"] ===
        "opencode/mimo-v2.6-flash-free",
      JSON.stringify(env2),
    );

    // TUI flags keep the root position, session subcommands are untouched,
    // and an explicit --standalone/--server is never duplicated.
    for (const [passthru, expected] of [
      [["--continue"], ["--standalone", "--continue"]],
      [["models"], ["models"]],
      [["--standalone", "run", "x"], ["--standalone", "run", "x"]],
    ] as Array<[string[], string[]]>) {
      const result3 = fixture.run(["opencode", "zen", "--", ...passthru], { config: REAL_CONFIG });
      check(result3.exitCode === 0, `${passthru.join(" ")}: ${result3.stderr.toString()}`);
      const [argv3] = fixture.child();
      expect(argv3, `${passthru.join(" ")} -> ${JSON.stringify(argv3)}`).toEqual(expected);
    }

    // explicit --model wins over the provider default
    const result4 = fixture.run(["opencode", "zen", "--model", "big-pickle"], {
      config: REAL_CONFIG,
    });
    check(result4.exitCode === 0, result4.stderr.toString());
    const [, env4] = fixture.child();
    check(
      (JSON.parse(env4["OPENCODE_CONFIG_CONTENT"]) as Record<string, unknown>)["model"] ===
        "opencode/big-pickle",
      JSON.stringify(env4),
    );
  }),
);

test(
  "test_opencode_deepseek",
  withFixture((fixture) => {
    const result = fixture.run(["opencode", "deepseek"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const [argv, env] = fixture.child();
    expect(argv, JSON.stringify(argv)).toEqual(["--standalone"]);
    check(env["DEEPSEEK_API_KEY"] === "secret-deepseek", JSON.stringify(env));
    check(
      (JSON.parse(env["OPENCODE_CONFIG_CONTENT"]) as Record<string, unknown>)["model"] ===
        "deepseek/deepseek-flash",
      JSON.stringify(env),
    );
    check(
      !("OPENROUTER_API_KEY" in env) && !("OPENCODE_API_KEY" in env),
      "other secrets must not leak",
    );
  }),
);

test(
  "test_pi_deepseek",
  withFixture((fixture) => {
    const result = fixture.run(["pi", "deepseek", "--", "-p", "hi"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const [argv, env] = fixture.child();
    expect(argv, JSON.stringify(argv)).toEqual([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-flash",
      "-p",
      "hi",
    ]);
    check(env["DEEPSEEK_API_KEY"] === "secret-deepseek", JSON.stringify(env));
    check(!("OPENROUTER_API_KEY" in env), "leak");

    const result2 = fixture.run(
      ["pi", "deepseek", "--model", "deepseek-v4-pro", "--", "-p", "hi"],
      { config: REAL_CONFIG },
    );
    check(result2.exitCode === 0, result2.stderr.toString());
    const [argv2] = fixture.child();
    check(argv2.includes("--model") && argv2.includes("deepseek-v4-pro"), JSON.stringify(argv2));
  }),
);

test(
  "test_dsh_passthrough",
  withFixture((fixture) => {
    const result = fixture.run(["dsh", "deepseek", "--", "web"], { config: REAL_CONFIG });
    check(result.exitCode === 0, result.stderr.toString());
    const [argv, env] = fixture.child();
    expect(argv, JSON.stringify(argv)).toEqual(["web"]);
    check(env["DEEPSEEK_API_KEY"] === "secret-deepseek", JSON.stringify(env));

    const result2 = fixture.run(["dsh", "deepseek", "--model", "x"], { config: REAL_CONFIG });
    check(result2.exitCode === 2, "dsh must reject --model");
    check(result2.stderr.toString().includes("does not accept --model"), result2.stderr.toString());
  }),
);

test(
  "test_forbidden_passthru_flags",
  withFixture((fixture) => {
    const cases: Array<[string[], string]> = [
      [["pi", "openrouter", "--", "--model", "x"], "--model"],
      [["claude", "deepseek", "--", "--model=deepseek-v4-pro"], "--model"],
      [["claude", "openrouter", "--", "--fallback-model", "x"], "--fallback-model"],
      [["claude", "openrouter", "--", "--fallback-model=x"], "--fallback-model"],
      [["pi", "openrouter", "--", "--api-key", "x"], "--api-key"],
      [["pi", "deepseek", "--", "--provider", "openrouter"], "--provider"],
    ];
    for (const [args, needle] of cases) {
      const result = fixture.run(args, { config: REAL_CONFIG });
      check(result.exitCode === 2, `${args.join(" ")} -> ${result.exitCode}`);
      check(
        result.stderr.toString().includes(needle),
        `${args.join(" ")}: ${result.stderr.toString()}`,
      );
    }
  }),
);

test(
  "test_model_precedence",
  withFixture((fixture) => {
    const config = join(fixture.tmp, "precedence.toml");
    writeFileSync(config, PRECEDENCE_CONFIG);

    const result = fixture.run(["h1", "p1"], { config });
    check(result.exitCode === 0, result.stderr.toString());
    const [, env] = fixture.child();
    check(
      env["ANTHROPIC_MODEL"] === "route-model",
      `route default must win: ${env["ANTHROPIC_MODEL"]}`,
    );

    const result2 = fixture.run(["h1", "p1", "--model", "cli-model"], { config });
    check(result2.exitCode === 0, result2.stderr.toString());
    const [, env2] = fixture.child();
    check(env2["ANTHROPIC_MODEL"] === "cli-model", "CLI --model must win");
    check(env2["ANTHROPIC_DEFAULT_SONNET_MODEL"] === "cli-model", JSON.stringify(env2));

    const result3 = fixture.run(["h1", "p1", "-m", "cli-model"], { config });
    check(result3.exitCode === 0, result3.stderr.toString());
    const [, env3] = fixture.child();
    check(env3["ANTHROPIC_MODEL"] === "cli-model", "-m must work");
  }),
);

test(
  "test_fast_path_drops_declared_provider_creds",
  withFixture((fixture) => {
    // All secrets preset: no wrapper, but other providers' creds still drop.
    const config = join(fixture.tmp, "precedence.toml");
    writeFileSync(config, PRECEDENCE_CONFIG);
    const result = fixture.run(["h1", "p1"], {
      env: {
        DEEPSEEK_API_KEY: "preset-p1",
        CUSTOMP_API_KEY: "preset-p2",
      },
      config,
    });
    check(result.exitCode === 0, result.stderr.toString());
    const [, env] = fixture.child();
    check(env["DEEPSEEK_API_KEY"] === "preset-p1", "selected provider secret must survive");
    check(!("CUSTOMP_API_KEY" in env), "declared provider secret must be dropped on the fast path");
    check(!existsSync(fixture.marker), "fast path must not invoke with-secrets");
  }),
);

test(
  "test_agent_model_env_warns",
  withFixture((fixture) => {
    const result = fixture.run(["claude", "openrouter"], {
      env: { AGENT_MODEL: "legacy-model" },
      config: REAL_CONFIG,
    });
    check(result.exitCode === 0, result.stderr.toString());
    check(result.stderr.toString().includes("AGENT_MODEL is no longer read"), result.stderr.toString());
    const [, env] = fixture.child();
    check(
      env["ANTHROPIC_MODEL"] === "z-ai/glm-5.3-flash",
      `legacy env must not select the model: ${env["ANTHROPIC_MODEL"]}`,
    );
  }),
);

test(
  "test_missing_harness",
  withFixture((fixture) => {
    const config = join(fixture.tmp, "ghost.toml");
    writeFileSync(config, GHOST_CONFIG);
    const result = fixture.run(["ghost", "p1"], { config });
    check(
      result.exitCode === 1,
      `expected 1, got ${result.exitCode}: ${result.stderr.toString()}`,
    );
    check(result.stderr.toString().includes("harness not found"), result.stderr.toString());
    check(!existsSync(fixture.marker), "credentials must not be fetched first");
  }),
);

test(
  "test_invalid_configs",
  withFixture((fixture) => {
    const cases: Array<[string, string]> = [
      // provider without default and route without require_model
      [
        `
[providers.p1]
label = "P"
models = ["m"]

[harnesses.h1]
label = "H"
command = "claude"
adapter = "anthropic"
[harnesses.h1.env]
base_url = "ANTHROPIC_BASE_URL"
auth_token = "ANTHROPIC_AUTH_TOKEN"
api_key = "ANTHROPIC_API_KEY"
model = "ANTHROPIC_MODEL"
small_fast_model = "ANTHROPIC_SMALL_FAST_MODEL"
default_opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
default_sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
default_haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"

[routes."h1.p1"]
`,
        "no default model",
      ],
      [
        `
[providers.p1]
label = "P"
default_model = "m"
models = ["m"]

[harnesses.h1]
label = "H"
command = "claude"
adapter = "telepathy"
`,
        "unknown adapter",
      ],
      [
        `
[providers.p1]
label = "P"
default_model = "not-listed"
models = ["m"]
`,
        "is not in models",
      ],
      [
        `
[providers.p1]
label = "P"
default_model = "m"
require_model = true
models = ["m"]
`,
        "contradicts",
      ],
      [
        `
[providers.p1]
label = "P"
default_model = "m"

[harnesses.h1]
label = "H"
command = "claude"
adapter = "anthropic"
[harnesses.h1.env]
base_url = "ANTHROPIC_BASE_URL"
auth_token = "ANTHROPIC_AUTH_TOKEN"
api_key = "ANTHROPIC_API_KEY"
model = "ANTHROPIC_MODEL"
small_fast_model = "ANTHROPIC_SMALL_FAST_MODEL"
default_opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
default_sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
default_haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"

[routes."h1.p1"]
`,
        "needs provider",
      ],
      [
        `
[providers.p1]
label = "P"
default_model = "m"
models = ["m"]

[harnesses.h1]
label = "H"
command = "true"
adapter = "passthrough"

[routes."nope.p1"]
`,
        "unknown harness",
      ],
    ];
    for (const [index, [content, needle]] of cases.entries()) {
      const config = join(fixture.tmp, `invalid-${index}.toml`);
      writeFileSync(config, content);
      const result = fixture.run(["check"], { config });
      check(
        result.exitCode === 2,
        `invalid config ${index} must fail, got ${result.exitCode}: ${result.stdout.toString()}`,
      );
      check(
        result.stderr.toString().includes(needle),
        `invalid config ${index}: expected '${needle}', got '${result.stderr.toString()}'`,
      );
    }
  }),
);
