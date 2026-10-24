import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
const script = join(import.meta.dir, "devnode.ts");
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), "devnode-test-"))); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function run(state: string, args: string[]) {
  return Bun.spawnSync([process.execPath, script, ...args, "--state-dir", state]);
}
function prepare(state: string) {
  const result = run(state, ["prepare", "--name", "win-uuu", "--no-passphrase"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test("prepare generates a device-local identity once and reruns without changing its key", () => {
  const state = root();
  const first = prepare(state);
  const privateKey = readFileSync(first.privateKeyPath);
  const second = prepare(state);
  expect(second.instanceId).toBe(first.instanceId);
  expect(readFileSync(second.privateKeyPath)).toEqual(privateKey);
  expect(first.status).toBe("new");
  expect(first).not.toHaveProperty("active");
  expect(readFileSync(first.publicKeyPath, "utf8")).toContain("ssh-ed25519 ");
  if (process.platform !== "win32") expect(statSync(first.privateKeyPath).mode & 0o077).toBe(0);
});

test("prepare rejects unmanaged directories and symlinks without touching their contents", () => {
  const state = root();
  mkdirSync(join(state, "win-uuu"));
  const unmanaged = run(state, ["prepare", "--name", "win-uuu", "--no-passphrase"]);
  expect(unmanaged.exitCode).not.toBe(0);
  expect(existsSync(join(state, "win-uuu", "id_ed25519"))).toBe(false);
  if (process.platform === "win32") return;
  const outside = root();
  symlinkSync(outside, join(state, "link"));
  const linked = run(join(state, "link"), ["prepare", "--name", "win-uuu", "--no-passphrase"]);
  expect(linked.exitCode).not.toBe(0);
  expect(existsSync(join(outside, "win-uuu"))).toBe(false);
});

test("names cannot escape the state directory or inject SSH directives", () => {
  const state = root();
  for (const name of ["../outside", "host\nProxyCommand bad", "-oProxyCommand=bad", ""]) {
    expect(run(state, ["prepare", "--name", name, "--no-passphrase"]).exitCode).not.toBe(0);
  }
});

test("trust refuses a changed fingerprint and pins a matching host into dedicated SSH config", async () => {
  const { pinHost } = await import("./devnode.ts");
  const state = root();
  const node = prepare(state);
  const observed = readFileSync(node.publicKeyPath, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  const fingerprint = execFileSync("ssh-keygen", ["-lf", node.publicKeyPath], { encoding: "utf8" }).split(/\s+/)[1];
  const request = { name: "win-uuu", host: "127.0.0.1", port: 22222, user: "rebui", fingerprint };
  expect(() => pinHost(state, { ...request, fingerprint: "SHA256:" + "A".repeat(43) }, `127.0.0.1 ${observed}`)).toThrow();
  expect(existsSync(join(state, "win-uuu", "ssh_config"))).toBe(false);
  pinHost(state, request, `127.0.0.1 ${observed}`);
  pinHost(state, request, `127.0.0.1 ${observed}`);
  const config = join(state, "win-uuu", "ssh_config");
  const effective = execFileSync("ssh", ["-G", "-F", config, "devnode-win-uuu"], { encoding: "utf8" });
  expect(effective).toContain("hostname 127.0.0.1\n");
  expect(effective).toContain("port 22222\n");
  expect(effective).toContain("stricthostkeychecking true\n");
  expect(effective).toContain("forwardagent no\n");
  expect(effective).toContain("identitiesonly yes\n");
  expect(effective).toContain("controlmaster false\n");
  expect(() => pinHost(state, { ...request, user: "other" }, `127.0.0.1 ${observed}`)).toThrow();
  expect(readFileSync(config, "utf8")).toContain("User rebui\n");
});

test("verify fails closed without approved trust and on a refused SSH endpoint", async () => {
  const { pinHost } = await import("./devnode.ts");
  const state = root();
  const node = prepare(state);
  expect(run(state, ["verify", "--name", "win-uuu"]).exitCode).not.toBe(0);
  const observed = readFileSync(node.publicKeyPath, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  const fingerprint = execFileSync("ssh-keygen", ["-lf", node.publicKeyPath], { encoding: "utf8" }).split(/\s+/)[1];
  // Hold a real local listener that immediately refuses the SSH handshake.
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.end(); }, open(socket) { socket.end(); } } });
  try {
    pinHost(state, { name: "win-uuu", host: "127.0.0.1", port: server.port, user: "rebui", fingerprint }, `127.0.0.1 ${observed}`);
    const child = Bun.spawn([process.execPath, script, "verify", "--name", "win-uuu", "--state-dir", state], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('"status":"ssh-verified"');
  } finally { server.stop(true); }
});

test("verify refuses drift of the host pin before invoking SSH", async () => {
  const { pinHost, verify } = await import("./devnode.ts");
  const state = root();
  const node = prepare(state);
  const observed = readFileSync(node.publicKeyPath, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  const fingerprint = execFileSync("ssh-keygen", ["-lf", node.publicKeyPath], { encoding: "utf8" }).split(/\s+/)[1];
  pinHost(state, { name: "win-uuu", host: "127.0.0.1", port: 22222, user: "rebui", fingerprint }, `127.0.0.1 ${observed}`);
  writeFileSync(join(state, "win-uuu", "known_hosts"), `other-host ${observed}\n`);
  expect(() => verify(state, "win-uuu")).toThrow("host pin drift");
});
