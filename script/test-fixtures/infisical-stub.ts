// Test double for infisical.exe. Compiled with `bun build --compile` by
// script/agent.windows.test.ts; records its environment and argv as JSON.
import { writeFileSync } from "node:fs";

const capture = process.env.CAPTURE_FILE;
if (!capture) throw new Error("CAPTURE_FILE must be set");
writeFileSync(
  capture,
  JSON.stringify({ url: process.env.INFISICAL_API_URL ?? null, argv: process.argv.slice(2) }),
);
