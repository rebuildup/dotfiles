#!/usr/bin/env bun
/** Supply OCR's api_key_cmd from the canonical Infisical project, never ambient credentials. */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// OCR provider name -> Infisical secret in environment `dev`. The `minimax`
// entry mirrors config/agents.toml [providers.minimax] (`secret`); the
// `opencode-go` entry mirrors its OPENCODE_API_KEY credential. The map is
// deliberately closed: an unknown provider fails before any secret lookup so
// a config typo cannot fetch an arbitrary Infisical value.
const PROVIDER_SECRETS = {
  minimax: "MINIMAX_M_PLAN_KEY",
  "opencode-go": "OPENCODE_API_KEY",
} as const;

type OcrProvider = keyof typeof PROVIDER_SECRETS;

function fail(message: string): never {
  process.stderr.write(`ocr-key: ${message}\n`);
  process.exit(1);
}

const provider = process.argv[2];
if (!provider || !Object.hasOwn(PROVIDER_SECRETS, provider)) {
  fail(`usage: ocr-key <${Object.keys(PROVIDER_SECRETS).join("|")}>`);
}
const secretName = PROVIDER_SECRETS[provider as OcrProvider];

if (process.argv[3] === "--emit-injected-key") {
  if (process.argv.length !== 4) {
    fail("unexpected arguments");
  }
  // This stage is launched ONLY by script/with-secrets( .ps1 ) after the
  // parent has removed any inherited ambient value of the target secret.
  const key = process.env[secretName];
  if (!key || !key.trim() || /[\r\n]/.test(key)) {
    fail(`${secretName} is missing or malformed in the Infisical environment`);
  }
  process.stdout.write(`${key}\n`);
} else if (process.argv.length !== 3) {
  fail("unexpected arguments");
} else {
  const cleanEnv = { ...process.env };
  delete cleanEnv[secretName];
  // The tracked with-secrets wrappers verify the bound self-hosted project.
  // No secret appears in the command arguments, checked-in config, or stderr.
  const script = join(repoRoot, "script", process.platform === "win32" ? "with-secrets.ps1" : "with-secrets");
  const self = fileURLToPath(import.meta.url);
  const executable = process.platform === "win32" ? "pwsh" : script;
  const args = process.platform === "win32"
    ? ["-NoProfile", "-File", script, "bun", self, provider, "--emit-injected-key"]
    : ["bun", self, provider, "--emit-injected-key"];
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: cleanEnv,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail("Infisical retrieval failed; check login, project binding, and secret availability");
  }
  const key = result.stdout.replace(/\r?\n$/, "");
  if (!key || !key.trim() || /[\r\n]/.test(key)) {
    fail("secret output was empty or contained unexpected extra lines");
  }
  process.stdout.write(`${key}\n`);
}
