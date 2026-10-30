// Throwaway live PoC. Synthetic secret only; creates and removes ONE owned project/MI.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--execute")) {
  console.log("Requires --execute. Creates a disposable project and Machine Identity on secrets.rebuildup.dev, tests one-use login/project separation/revocation, then removes only those resources. No credentials are printed or saved.");
  process.exit(0);
}
const site = "https://secrets.rebuildup.dev";
const org = "d808df2c-ec67-4046-b733-8c0db0bfa47d";
const existingProject = "d4c2fc09-a923-4a38-9cf4-b51769aadb76";
const cli = "/Users/rebui/.local/share/mise/installs/infisical/0.44.8/infisical";
const runId = randomUUID();
const name = "devnode-poc-" + runId;
const scratch = mkdtempSync(join(tmpdir(), "devnode-infisical-poc-"));
const journalPath = join(scratch, "recovery.json");
const journal: any = {
  runId, name, site, organizationId: org, startedAt: new Date().toISOString(),
  schemaSha256: createHash("sha256").update(readFileSync("/tmp/devnode-infisical-live-openapi.json")).digest("hex"),
  sourceSha256: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),
  observations: [], resources: {}, status: "running",
};
function save() { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 }); }
save();
console.log(JSON.stringify({ runId, name, journalPath }));
function check(label: string, pass: boolean, observed?: number) {
  journal.observations.push({ label, pass, ...(observed === undefined ? {} : { httpStatus: observed }) });
  save();
  console.log(JSON.stringify({ label, pass, ...(observed === undefined ? {} : { httpStatus: observed }) }));
  if (!pass) throw new Error("check failed: " + label);
}
function observe(label: string, pass: boolean, observed: number) {
  journal.observations.push({ label, pass, httpStatus: observed });
  save();
  console.log(JSON.stringify({ label, pass, httpStatus: observed }));
  if (!pass) failure = true;
}
function ownedId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) throw new Error("unexpected resource ID");
  return value;
}
let human = "";
let projectId = "";
let identityId = "";
let machineToken = "";
let clientId = "";
let clientSecret = "";
let member = false;
let tokenValidUntil = 0;
function api(method: string, path: string, token: string, body?: unknown) {
  if (!path.startsWith("/api/") || /[\r\n]/.test(path) || /\s/.test(token)) throw new Error("invalid request boundary");
  const config = [
    "url = " + JSON.stringify(site + path),
    "request = " + JSON.stringify(method),
    'header = "Accept: application/json"',
    ...(body === undefined ? [] : ['header = "Content-Type: application/json"']),
    ...(token ? ["header = " + JSON.stringify("Authorization: Bearer " + token)] : []),
    ...(body === undefined ? [] : ["data = " + JSON.stringify(JSON.stringify(body))]),
  ].join("\n") + "\n";
  const result = spawnSync("/usr/bin/curl", ["-q", "--silent", "--show-error", "--no-location", "--proto", "=https", "--max-time", "15", "--config", "-", "--write-out", "\n%{http_code}"], { input: config, encoding: "utf8", timeout: 18000, maxBuffer: 5 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("HTTP transport failed; credential-bearing response suppressed");
  const boundary = result.stdout.lastIndexOf("\n");
  const status = Number(result.stdout.slice(boundary + 1));
  let data: any;
  try { data = JSON.parse(result.stdout.slice(0, boundary)); }
  catch { throw new Error("non-JSON response; response suppressed"); }
  return { status, data };
}
function secretPath(project: string) {
  return "/api/v4/secrets/" + "DEVNODE_POC_" + runId.replaceAll("-", "_") + "?" + new URLSearchParams({ projectId: project, environment: "dev", secretPath: "/", expandSecretReferences: "false", includeImports: "false" });
}
const secretName = "DEVNODE_POC_" + runId.replaceAll("-", "_");
const sentinel = "synthetic-not-a-real-credential-" + randomUUID();
let failure = false;
try {
  human = execFileSync(cli, ["user", "get", "token", "--plain", "--domain", site + "/api"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!human || /\s/.test(human)) throw new Error("existing human login unavailable");
  const plan = api("GET", "/api/v1/organizations/" + org + "/plan", human);
  check("existing user can read this organization plan", plan.status === 200, plan.status);
  const created = spawnSync(cli, ["sm", "projects", "create", "--name", name, "--slug", name, "--description", "Disposable development-node admission PoC; synthetic secret only; delete after verification.", "--org", org, "--domain", site + "/api", "--output", "json", "--silent"], { cwd: scratch, encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] });
  if (created.status !== 0) throw new Error("official project-create CLI failed; check recovery journal/name before retrying");
  const output = JSON.parse(created.stdout);
  const project = output.workspace ?? output.project ?? output;
  projectId = ownedId(project.id);
  journal.resources.projectId = projectId; save();
  check("created project has this run's owned name", project.name === name);
  const testSecret = api("POST", "/api/v4/secrets/" + secretName, human, { projectId, environment: "dev", secretPath: "/", secretValue: sentinel, type: "shared" });
  check("synthetic secret created only in disposable project/dev", testSecret.status === 200, testSecret.status);
  const identity = api("POST", "/api/v1/identities", human, { name, organizationId: org, role: "no-access", metadata: [{ key: "purpose", value: "disposable-devnode-poc" }, { key: "runId", value: runId }] });
  check("instance-specific Machine Identity created", identity.status === 200, identity.status);
  identityId = ownedId(identity.data.identity?.id);
  journal.resources.identityId = identityId; save();
  check("created Machine Identity ownership matches", identity.data.identity?.name === name && identity.data.identity?.orgId === org);
  const auth = api("POST", "/api/v1/auth/universal-auth/identities/" + identityId, human, { accessTokenTTL: 120, accessTokenMaxTTL: 120, accessTokenPeriod: 0, accessTokenNumUsesLimit: 0 });
  check("Universal Auth bounded to 120 seconds with no renewable period", auth.status === 200 && auth.data.identityUniversalAuth?.accessTokenTTL === 120 && auth.data.identityUniversalAuth?.accessTokenMaxTTL === 120 && auth.data.identityUniversalAuth?.accessTokenPeriod === 0, auth.status);
  clientId = auth.data.identityUniversalAuth.clientId;
  const membership = api("POST", `/api/v1/projects/${projectId}/memberships/identities/${identityId}`, human, { role: "viewer" });
  check("built-in viewer granted only to disposable project", membership.status === 200, membership.status);
  member = true;
  const firstClientIssuedAt = Date.now();
  const issued = api("POST", `/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, human, { description: "One-use node bootstrap proof", ttl: 120, numUsesLimit: 1 });
  check("registration client secret is one-use and 120-second TTL", issued.status === 200 && issued.data.clientSecretData?.clientSecretNumUsesLimit === 1 && issued.data.clientSecretData?.clientSecretTTL === 120, issued.status);
  clientSecret = issued.data.clientSecret;
  if (typeof clientSecret !== "string" || !clientSecret) throw new Error("credential response incomplete; suppressed");
  const loginStartedAt = Date.now();
  const login = api("POST", "/api/v1/auth/universal-auth/login", "", { clientId, clientSecret });
  check("first bootstrap login succeeds with bounded token", login.status === 200 && login.data.expiresIn > 0 && login.data.expiresIn <= 120 && login.data.accessTokenMaxTTL <= 120, login.status);
  machineToken = login.data.accessToken;
  tokenValidUntil = loginStartedAt + login.data.expiresIn * 1000;
  journal.tokenExpiresAt = new Date(tokenValidUntil).toISOString(); save();
  const replay = api("POST", "/api/v1/auth/universal-auth/login", "", { clientId, clientSecret });
  check("replay response arrives before bootstrap credential expiry", Date.now() + 5000 < firstClientIssuedAt + 120000);
  check("identical registration credential replay rejected", [400, 401, 403].includes(replay.status), replay.status);
  const read = api("GET", secretPath(projectId), machineToken);
  check("node can read its synthetic secret in explicit project/dev", read.status === 200 && read.data.secret?.secretValue === sentinel, read.status);
  const write = api("PATCH", "/api/v4/secrets/" + secretName, machineToken, { projectId, environment: "dev", secretPath: "/", secretValue: "write-must-be-denied" });
  check("write denial response arrives before token expiry", Date.now() + 5000 < tokenValidUntil);
  check("viewer cannot mutate even its own project's secret", write.status === 403, write.status);
  const outside = api("GET", secretPath(existingProject), machineToken);
  check("cross-project denial response arrives before token expiry", Date.now() + 5000 < tokenValidUntil);
  check("node denied access to existing dotfiles project using nonexistent synthetic key", outside.status === 403, outside.status);
  const revoke = api("DELETE", `/api/v1/projects/${projectId}/memberships/identities/${identityId}`, human);
  check("node's owned project membership revoked", revoke.status === 200, revoke.status);
  member = false;
  const missingMembership = api("GET", `/api/v1/projects/${projectId}/memberships/identities/${identityId}`, human);
  check("revoked membership is absent in provider metadata", missingMembership.status === 404, missingMembership.status);
  check("revocation proof runs before natural token expiry", Date.now() + 5000 < tokenValidUntil);
  const afterRevoke = api("GET", secretPath(projectId), machineToken);
  check("membership-revocation response arrives before token expiry", Date.now() + 5000 < tokenValidUntil);
  observe("previously issued token denied after membership revocation", afterRevoke.status === 403, afterRevoke.status);
  const restore = api("POST", `/api/v1/projects/${projectId}/memberships/identities/${identityId}`, human, { role: "viewer" });
  check("membership restored only for independent identity deletion proof", restore.status === 200, restore.status);
  member = true;
  const liveRead = api("GET", secretPath(projectId), machineToken);
  check("same unexpired token works immediately before identity deletion", liveRead.status === 200 && liveRead.data.secret?.secretValue === sentinel, liveRead.status);
  const unusedIssuedAt = Date.now();
  const fresh = api("POST", `/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, human, { description: "Unused credential for independent retirement proof", ttl: 120, numUsesLimit: 1 });
  check("unused bounded credential prepared for identity deletion proof", fresh.status === 200 && fresh.data.clientSecretData?.clientSecretNumUses === 0 && fresh.data.clientSecretData?.clientSecretTTL === 120 && fresh.data.clientSecretData?.clientSecretNumUsesLimit === 1, fresh.status);
  const unusedSecret = fresh.data.clientSecret;
  const unusedValidUntil = unusedIssuedAt + 120000;
  if (typeof unusedSecret !== "string" || !unusedSecret) throw new Error("unused credential response incomplete; suppressed");
  const remove = api("DELETE", "/api/v1/identities/" + identityId, human);
  check("owned node Machine Identity deleted", remove.status === 200, remove.status);
  identityId = "";
  journal.resources.identityDeleted = true; save();
  check("deletion proof runs before token and unused credential expiry", Date.now() + 5000 < tokenValidUntil && Date.now() + 5000 < unusedValidUntil);
  const afterDelete = api("GET", secretPath(projectId), machineToken);
  check("identity-deletion response arrives before token expiry", Date.now() + 5000 < tokenValidUntil);
  observe("old token denied after identity deletion", [401, 403].includes(afterDelete.status), afterDelete.status);
  const oldLogin = api("POST", "/api/v1/auth/universal-auth/login", "", { clientId, clientSecret: unusedSecret });
  check("retired credential rejection arrives before its natural expiry", Date.now() + 5000 < unusedValidUntil);
  observe("retired identity's previously unused bootstrap credential cannot rejoin", [400, 401, 403].includes(oldLogin.status), oldLogin.status);
  journal.status = failure ? "partial-failed-checks" : "checks-passed";
} catch (error) {
  failure = true;
  journal.status = "failed";
  journal.failure = error instanceof Error && !/Command failed/.test(error.message) ? error.message : "PoC failed; sensitive command response suppressed";
  console.error(journal.failure);
} finally {
  const cleanup: any[] = [];
  if (!identityId && journal.resources.identityId && human) {
    try {
      const absent = api("GET", "/api/v1/identities/" + ownedId(journal.resources.identityId), human);
      cleanup.push({ resource: "identity", id: journal.resources.identityId, removed: absent.status === 404, absentStatus: absent.status });
    } catch { cleanup.push({ resource: "identity", id: journal.resources.identityId, removed: false }); }
  }
  if (identityId && human) {
    try {
      const owned = api("GET", "/api/v1/identities/" + identityId, human);
      const membership = owned.data.identity;
      if (owned.status !== 200 || membership?.identityId !== identityId || membership?.identity?.id !== identityId || membership?.identity?.name !== name || membership?.orgId !== org) throw new Error("identity ownership not confirmed");
      const removed = api("DELETE", "/api/v1/identities/" + identityId, human);
      const absent = api("GET", "/api/v1/identities/" + identityId, human);
      cleanup.push({ resource: "identity", id: identityId, removed: removed.status === 200 && absent.status === 404, absentStatus: absent.status });
    } catch { cleanup.push({ resource: "identity", id: identityId, removed: false }); }
  }
  if (projectId && human) {
    try {
      const owned = api("GET", "/api/v1/workspace/" + projectId, human);
      if (owned.status !== 200 || owned.data.workspace?.name !== name || owned.data.workspace?.orgId !== org) throw new Error("project ownership not confirmed");
      const removed = api("DELETE", "/api/v1/workspace/" + projectId, human);
      const absent = api("GET", "/api/v1/workspace/" + projectId, human);
      cleanup.push({ resource: "project", id: projectId, removed: removed.status === 200 && absent.status === 404, deleteStatus: removed.status, absentStatus: absent.status });
    } catch { cleanup.push({ resource: "project", id: projectId, removed: false }); }
  }
  journal.cleanup = cleanup;
  journal.finishedAt = new Date().toISOString();
  if (cleanup.some(x => !x.removed)) { journal.status = "cleanup-pending"; failure = true; }
  save();
  console.log(JSON.stringify({ runId, status: journal.status, cleanup, journalPath }));
  human = machineToken = clientId = clientSecret = "";
  process.exitCode = failure ? 1 : 0;
}
