import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const EVALUATION_VERSION = "agent-e2e-v8";
export const EVALUATION_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "agent-eval",
);
export function evaluationFixtureDigest(): string {
  const hash = createHash("sha256");
  function visit(dir: string, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), relative + "/");
      else if (entry.isFile())
        hash
          .update(relative + "\0")
          .update(readFileSync(join(dir, entry.name)))
          .update("\0");
      else throw new Error("fixture contains unsupported file");
    }
  }
  visit(EVALUATION_FIXTURE);
  return hash.digest("hex");
}
