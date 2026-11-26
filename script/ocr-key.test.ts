import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROVIDER_SECRETS, isOcrProvider } from "./ocr-key";

const REPO = dirname(dirname(realpathSync(import.meta.path)));
const SCRIPT = join(REPO, "script", "ocr-key.ts");

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("ocr-key provider map", () => {
  test("minimax secret mirrors config/agents.toml [providers.minimax].secret", () => {
    const agents = Bun.TOML.parse(readFileSync(join(REPO, "config", "agents.toml"), "utf8")) as {
      providers: Record<string, { secret?: string }>;
    };
    expect(agents.providers.minimax?.secret).toBe(PROVIDER_SECRETS.minimax);
  });

  test("every api_key_cmd provider in the OCR config is one the bridge accepts", () => {
    const ocr = JSON.parse(readFileSync(join(REPO, "home", ".opencodereview", "config.json"), "utf8")) as {
      provider: string;
      providers?: Record<string, { api_key_cmd?: string }>;
      custom_providers?: Record<string, { api_key_cmd?: string }>;
    };
    const entries = { ...ocr.providers, ...ocr.custom_providers };
    for (const [name, entry] of Object.entries(entries)) {
      const cmd = entry.api_key_cmd;
      if (!cmd) continue;
      const match = /^ocr-key (\S+)$/.exec(cmd);
      expect(match, `${name}.api_key_cmd must be 'ocr-key <provider>'`).not.toBeNull();
      expect(isOcrProvider(match![1]), `${name} uses unknown provider '${match![1]}'`).toBe(true);
    }
    // The selected provider must resolve a credential through the bridge.
    const active = entries[ocr.provider];
    expect(active?.api_key_cmd, `provider '${ocr.provider}' has no api_key_cmd`).toBeTruthy();
  });
});

describe("ocr-key dispatch", () => {
  test("unknown provider fails closed before any Infisical lookup", () => {
    const result = run(["bogus"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("usage: ocr-key");
  });

  test("prototype keys are not providers", () => {
    expect(isOcrProvider("constructor")).toBe(false);
    expect(isOcrProvider("minimax")).toBe(true);
    expect(isOcrProvider("opencode-go")).toBe(true);
  });

  test("emit stage refuses to run without the parent hop nonce", () => {
    const result = run(["minimax", "--emit-injected-key"], { MINIMAX_M_PLAN_KEY: "ambient-value" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).not.toContain("ambient-value");
  });

  test("emit stage prints exactly the injected secret for its own provider", () => {
    const result = run(["minimax", "--emit-injected-key"], {
      OCR_KEY_HOP_NONCE: "test-nonce",
      MINIMAX_M_PLAN_KEY: "plan-key",
      OPENCODE_API_KEY: "go-key",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("plan-key\n");
  });

  test("emit stage never prints another provider's secret", () => {
    const result = run(["opencode-go", "--emit-injected-key"], {
      OCR_KEY_HOP_NONCE: "test-nonce",
      MINIMAX_M_PLAN_KEY: "plan-key",
      OPENCODE_API_KEY: "go-key",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("go-key\n");
  });

  test("emit stage rejects empty and multi-line values", () => {
    for (const bad of ["", "two\nlines"]) {
      const result = run(["minimax", "--emit-injected-key"], {
        OCR_KEY_HOP_NONCE: "test-nonce",
        MINIMAX_M_PLAN_KEY: bad,
      });
      expect(result.exitCode).not.toBe(0);
    }
  });
});
