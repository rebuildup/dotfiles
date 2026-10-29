#!/usr/bin/env bun
// Connection PoC only: this does not enroll a node or grant Infisical access.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { isIP } from "node:net";

type Identity = { version: 1; kind: "devnode-connection-poc"; instanceId: string; name: string; status: "new" };
type Host = { name: string; host: string; port: number; user: string; fingerprint: string };
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function safeName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error("name must be a lowercase label (1–48 characters)");
  return name;
}
function safePath(path: string) {
  const absolute = resolve(path);
  if (/[\r\n\0"%$]/.test(absolute)) throw new Error("unsupported characters in state path");
  let ancestor = parse(absolute).root;
  for (const component of absolute.slice(ancestor.length).split(/[\\/]/).filter(Boolean)) {
    ancestor = join(ancestor, component);
    if (existsSync(ancestor) || (() => { try { return lstatSync(ancestor).isSymbolicLink(); } catch { return false; } })()) {
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("state path must contain real directories only");
    }
  }
  return absolute;
}
function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("managed file must be a regular file");
  if (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) {
    throw new Error("managed file must be owned by this user and private (0600)");
  }
}
function directory(root: string, name: string) { return join(safePath(root), safeName(name)); }
function load(root: string, name: string) {
  const dir = safePath(directory(root, name));
  regular(join(dir, "identity.json"));
  const value = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")) as Identity;
  if (value.version !== 1 || value.kind !== "devnode-connection-poc" || value.name !== name || !uuid.test(value.instanceId) || value.status !== "new") {
    throw new Error("unrecognized local identity; refusing to adopt or repair it");
  }
  regular(join(dir, "id_ed25519"));
  regular(join(dir, "id_ed25519.pub"));
  return { dir, value };
}
function sameOrCreate(path: string, content: string) {
  if (existsSync(path)) {
    regular(path);
    if (readFileSync(path, "utf8") !== content) throw new Error("existing connection differs; use a new instance instead of silently rotating trust");
  } else writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}
export function prepare(root: string, name: string, noPassphrase: boolean) {
  const dir = directory(root, name);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-f", join(dir, "id_ed25519"), "-C", `devnode-${name}`, ...(noPassphrase ? ["-N", ""] : [])], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("ssh-keygen failed; incomplete state retained for inspection");
    // Public material is kept private too, so every managed state file has one rule.
    chmodSync(join(dir, "id_ed25519.pub"), 0o600);
    const identity: Identity = { version: 1, kind: "devnode-connection-poc", instanceId: randomUUID(), name, status: "new" };
    writeFileSync(join(dir, "identity.json"), JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  }
  const { value } = load(root, name);
  return { ...value, privateKeyPath: join(dir, "id_ed25519"), publicKeyPath: join(dir, "id_ed25519.pub") };
}
function validateHost(request: Host) {
  safeName(request.name);
  if ((!isIP(request.host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(request.host)) || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(request.user)) {
    throw new Error("host/user must be plain addresses and account names, not SSH options");
  }
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error("invalid SSH port");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(request.fingerprint)) throw new Error("a separately confirmed SHA256 host fingerprint is required");
}
function quoted(path: string) { return '"' + path.replaceAll("\\", "/") + '"'; }
function config(dir: string, request: Host) {
  return `# devnode connection PoC; no global SSH settings are modified\nHost devnode-${request.name}\n  HostName ${request.host}\n  User ${request.user}\n  Port ${request.port}\n  IdentityFile ${quoted(join(dir, "id_ed25519"))}\n  UserKnownHostsFile ${quoted(join(dir, "known_hosts"))}\n  GlobalKnownHostsFile none\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n  ForwardAgent no\n  ForwardX11 no\n  ClearAllForwardings yes\n  PermitLocalCommand no\n  ProxyCommand none\n  ProxyJump none\n  ControlMaster no\n  ControlPath none\n  ConnectTimeout 8\n  ConnectionAttempts 1\n`;
}
export function pinHost(root: string, request: Host, observed: string) {
  validateHost(request);
  const { dir } = load(root, request.name);
  const keys = observed.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || fields[1] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+=*$/.test(fields[2])) throw new Error("unexpected host key response");
    return fields.slice(1).join(" ");
  });
  if (!keys.length || new Set(keys).size !== 1) throw new Error("expected exactly one distinct ed25519 host key");
  const key = keys[0];
  const actual = execFileSync("ssh-keygen", ["-lf", "-"], { input: key + "\n", encoding: "utf8" }).split(/\s+/)[1];
  if (actual !== request.fingerprint) throw new Error("host fingerprint mismatch; no trust was changed");
  const lock = join(dir, ".lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const knownHost = request.port === 22 ? request.host : `[${request.host}]:${request.port}`;
    const files = [
      [join(dir, "connection.json"), JSON.stringify(request) + "\n"],
      [join(dir, "known_hosts"), `${knownHost} ${key}\n`],
      [join(dir, "ssh_config"), config(dir, request)],
    ];
    // Check all conflicts before writing anything. A retry may finish an identical partial write.
    for (const [path, content] of files) {
      if (existsSync(path)) { regular(path); if (readFileSync(path, "utf8") !== content) throw new Error("existing connection differs; trust update refused"); }
    }
    for (const [path, content] of files) sameOrCreate(path, content);
    return { name: request.name, status: "host-pinned", fingerprint: actual, configPath: join(dir, "ssh_config") };
  } finally { rmdirSync(lock); }
}
export function verify(root: string, name: string) {
  const { dir, value } = load(root, name);
  for (const file of ["connection.json", "known_hosts", "ssh_config"]) regular(join(dir, file));
  const connection = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8")) as Host;
  validateHost(connection);
  if (connection.name !== name || readFileSync(join(dir, "ssh_config"), "utf8") !== config(dir, connection)) throw new Error("connection config drift; refusing SSH");
  const pin = readFileSync(join(dir, "known_hosts"), "utf8");
  const endpoint = connection.port === 22 ? connection.host : `[${connection.host}]:${connection.port}`;
  const fields = pin.trim().split(/\s+/);
  if (fields.length !== 3 || fields[0] !== endpoint || fields[1] !== "ssh-ed25519" || pin !== fields.join(" ") + "\n") throw new Error("host pin drift; refusing SSH");
  const actual = execFileSync("ssh-keygen", ["-lf", "-"], { input: pin, encoding: "utf8" }).split(/\s+/)[1];
  if (actual !== connection.fingerprint) throw new Error("host pin drift; refusing SSH");
  const nonce = "DEVNODE_" + randomBytes(16).toString("hex");
  const result = spawnSync("ssh", ["-F", join(dir, "ssh_config"), "-o", "BatchMode=yes", "-T", `devnode-${name}`, "echo", nonce], { encoding: "utf8", timeout: 15000 });
  if (result.status !== 0 || result.stdout.trim() !== nonce) throw new Error("SSH nonce verification failed (authentication, trust, endpoint, or timeout); no local fallback");
  return { name, instanceId: value.instanceId, status: "ssh-verified", herdr: "unverified", infisicalMachineIdentity: "unverified" };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === "sync") {
    const { main: sync } = await import("./devnode-sync.ts");
    console.log(JSON.stringify(sync(args))); return;
  }
  if (command === "machines") {
    const { main: machines } = await import("./devnode-machines.ts");
    console.log(JSON.stringify(machines(args))); return;
  }
  if (command === "update") {
    const { main: update } = await import("./devnode-update.ts");
    console.log(JSON.stringify(update(args))); return;
  }
  if (!command || command === "--help") {
    console.log("Connection PoC only: prepare --name LABEL [--no-passphrase]; trust --name LABEL --host ADDRESS --port PORT --user ACCOUNT --fingerprint SHA256:...; verify --name LABEL. Optional --state-dir PATH. No node enrollment or global SSH modification. Also: update check|apply --repo PATH --branch BRANCH; machines plan|apply|status --bindings PRIVATE_JSON --herdr ABSOLUTE_BINARY; sync --repo ABSOLUTE_PATH --branch BRANCH --bindings PRIVATE_JSON --herdr ABSOLUTE_BINARY.");
    return;
  }
  const options = new Map<string, string>();
  let noPassphrase = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--no-passphrase") { noPassphrase = true; continue; }
    if (!["--name", "--state-dir", "--host", "--port", "--user", "--fingerprint"].includes(flag) || options.has(flag) || !args.length) throw new Error("unknown, duplicate, or incomplete argument");
    options.set(flag, args.shift()!);
  }
  const root = options.get("--state-dir") ?? join(homedir(), ".local", "state", "dotfiles", "devnodes");
  const name = options.get("--name") ?? "";
  let result: unknown;
  if (command === "prepare") result = prepare(root, name, noPassphrase);
  else if (command === "trust") {
    const request: Host = { name, host: options.get("--host") ?? "", user: options.get("--user") ?? "", port: Number(options.get("--port") ?? 22222), fingerprint: options.get("--fingerprint") ?? "" };
    validateHost(request);
    const observed = execFileSync("ssh-keyscan", ["-T", "5", "-p", String(request.port), "-t", "ed25519", request.host], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    result = pinHost(root, request, observed);
  } else if (command === "verify") result = verify(root, name);
  else throw new Error("unknown command; join/leave/repair are not implemented in this connection PoC");
  console.log(JSON.stringify(result));
}
if (import.meta.main) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "devnode failed"); process.exitCode = 1; }
}
