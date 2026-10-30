#!/usr/bin/env bun
// Connection display reconciliation only. This never enrolls nodes or grants access.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

type Desired = { version: 1; machines: { name: string; label: string }[] };
type Binding = { name: string; profileId: string; target: string; session: string; expectedLabel: string };
type Bindings = { version: 1; bindings: Binding[] };
type Profile = { id: string; target: string; session: string; label: string; enabled?: boolean; selected?: boolean };
type Change = { name: string; profileId: string; target: string; session: string; from: string; to: string };
export type MachinePlan = { changes: Change[]; unchanged: string[]; unbound: string[] };
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("unrecognized machine configuration");
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp) { if (typeof value !== "string" || !pattern.test(value)) throw new Error("invalid machine configuration value"); return value; }
function label(value: unknown) { const result = text(value, /^[^\x00-\x1f\x7f]{1,80}$/u); if (result.trim() !== result) throw new Error("invalid display label"); return result; }
function unique(values: string[]) { if (new Set(values).size !== values.length) throw new Error("duplicate machine configuration value"); }
export function validateDesired(value: unknown): Desired {
  const d = object(value, ["version", "machines"]);
  if (d.version !== 1 || !Array.isArray(d.machines) || d.machines.length > 128) throw new Error("invalid desired machines");
  const machines = d.machines.map(item => { const m = object(item, ["name", "label"]); return { name: text(m.name, /^[a-z][a-z0-9-]{0,47}$/), label: label(m.label) }; });
  unique(machines.map(m => m.name)); unique(machines.map(m => m.label.normalize("NFC")));
  return { version: 1, machines };
}
export function validateBindings(value: unknown): Bindings {
  const d = object(value, ["version", "bindings"]);
  if (d.version !== 1 || !Array.isArray(d.bindings) || d.bindings.length > 128) throw new Error("invalid local bindings");
  const bindings = d.bindings.map(item => {
    const m = object(item, ["name", "profileId", "target", "session", "expectedLabel"]);
    return { name: text(m.name, /^[a-z][a-z0-9-]{0,47}$/), profileId: text(m.profileId, /^[a-f0-9]{32}$/), target: text(m.target, /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,252}$/), session: text(m.session, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/), expectedLabel: label(m.expectedLabel) };
  });
  unique(bindings.map(m => m.name)); unique(bindings.map(m => m.profileId));
  return { version: 1, bindings };
}
function profiles(value: unknown): Profile[] {
  if (!Array.isArray(value)) throw new Error("unexpected Herdr machine list");
  const result = value.map(m => {
    if (!m || typeof m !== "object") throw new Error("unexpected Herdr profile");
    return { id: text(m.id, /^[a-f0-9]{32}$/), target: text(m.target, /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,252}$/), session: text(m.session, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/), label: label(m.label), enabled: m.enabled, selected: m.selected };
  });
  unique(result.map(p => p.id)); return result;
}
export function planMachines(desiredValue: unknown, bindingValue: unknown, profileValue: unknown): MachinePlan {
  const desired = validateDesired(desiredValue), local = validateBindings(bindingValue), current = profiles(profileValue);
  const changes: Change[] = [], unchanged: string[] = [];
  for (const binding of local.bindings) {
    const want = desired.machines.find(m => m.name === binding.name);
    if (!want) throw new Error("local binding is absent from desired configuration");
    const profile = current.find(m => m.id === binding.profileId);
    if (!profile || profile.target !== binding.target || profile.session !== binding.session || ![binding.expectedLabel, want.label].includes(profile.label)) throw new Error("owned profile drift; binding must be reviewed before apply");
    if (current.some(m => m.id !== profile.id && m.label.normalize("NFC") === want.label.normalize("NFC"))) throw new Error("desired label belongs to another profile");
    if (profile.label === want.label) unchanged.push(binding.name);
    else changes.push({ name: binding.name, profileId: profile.id, target: profile.target, session: profile.session, from: profile.label, to: want.label });
  }
  return { changes, unchanged, unbound: desired.machines.filter(m => !local.bindings.some(b => b.name === m.name)).map(m => m.name) };
}

type Invoke = (args: string[]) => string;
export function reconcileMachines(mode: "plan" | "apply" | "status", desiredValue: unknown, bindingValue: unknown, invoke: Invoke, persist: (bindings: Bindings) => void) {
  if (!["plan", "apply", "status"].includes(mode)) throw new Error("invalid machine operation");
  const desired = validateDesired(desiredValue), local = validateBindings(bindingValue);
  const list = () => { try { return JSON.parse(invoke(["machine", "list", "--json"])); } catch { throw new Error("Herdr machine list failed or returned invalid JSON"); } };
  const plan = planMachines(desired, local, list());
  if (mode === "plan") return { ...plan, applied: [] };
  if (mode === "status") return { ...plan, statuses: local.bindings.map(b => {
    try { return { name: b.name, profiles: JSON.parse(invoke(["machine", "status", b.profileId, "--json"])) }; }
    catch { return { name: b.name, status: "unknown", reason: "herdr-status-failed" }; }
  }) };
  const applied: string[] = [];
  try {
    for (const change of plan.changes) {
      const fresh = planMachines(desired, local, list());
      if (!fresh.changes.some(c => c.profileId === change.profileId)) continue;
      invoke(["machine", "rename", change.profileId, "--label", change.to]);
      const checked = planMachines(desired, local, list());
      if (checked.changes.some(c => c.profileId === change.profileId)) throw new Error("Herdr did not retain requested label");
      applied.push(change.name);
    }
    const final = planMachines(desired, local, list());
    if (final.changes.length) throw new Error("machine labels changed concurrently");
    const next: Bindings = { version: 1, bindings: local.bindings.map(b => ({ ...b, expectedLabel: desired.machines.find(m => m.name === b.name)!.label })) };
    if (JSON.stringify(next) !== JSON.stringify(local)) persist(next);
    return { ...final, applied };
  } catch {
    throw new Error(`Machine apply incomplete; inspect official catalog before retry (confirmed renames: ${applied.join(",") || "none"}). No profile was added or removed.`);
  }
}
function readJsonFile(path: string, privateFile: boolean) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 131072) throw new Error("configuration must be a bounded regular file");
  if (privateFile && process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o077))) throw new Error("local bindings must be user-owned and private (0600)");
  if (privateFile && process.platform !== "win32") {
    const parent=lstatSync(dirname(path));
    if(!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==process.getuid!() || (parent.mode & 0o022)) throw new Error("binding parent must be user-owned and not writable by other users");
  }
  const raw = readFileSync(path, "utf8");
  return { raw, value: JSON.parse(raw.replace(/^\uFEFF/, "")) };
}
export function main(argv: string[]) {
  const mode = argv.shift();
  if (mode === "--help") return { usage: "devnode machines plan|apply|status --bindings PRIVATE_JSON --herdr ABSOLUTE_BINARY [--config DESIRED_JSON]", scope: "Owned display labels only; no enrollment, credential synchronization or profile add/remove." };
  if (!["plan", "apply", "status"].includes(mode ?? "")) throw new Error("expected machines plan|apply|status");
  const options = new Map<string, string>();
  while (argv.length) {
    const flag = argv.shift()!, value = argv.shift();
    if (!["--bindings", "--herdr", "--config"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) throw new Error("unknown, duplicate or incomplete machine option");
    options.set(flag, value);
  }
  const bindingsArg = options.get("--bindings"), binary = options.get("--herdr");
  if (!bindingsArg || !binary || !isAbsolute(binary)) throw new Error("explicit --bindings and absolute --herdr are required");
  const bindingPath = resolve(bindingsArg), configPath = resolve(options.get("--config") ?? join(import.meta.dir, "..", "config", "devnode-machines.json"));
  const desired = validateDesired(readJsonFile(configPath, false).value);
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot;
    if (!windowsRoot || !isAbsolute(windowsRoot)) throw new Error("Windows system directory unavailable");
    try {
      const result = execFileSync(join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(import.meta.dir, "devnode-bindings-acl.ps1"), "-LiteralPath", bindingPath], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.trim() !== "private-binding-acl-ok") throw new Error("invalid ACL check response");
    } catch { throw new Error("Windows binding ACL check failed; use a user-owned protected private directory"); }
  }
  const original = readJsonFile(bindingPath, true), bindings = validateBindings(original.value);
  // Validate the selected binding before starting any external command.
  if (bindings.bindings.some(b => !desired.machines.some(m => m.name === b.name))) throw new Error("binding absent from desired configuration");
  const invoke: Invoke = args => {
    try { return execFileSync(binary, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new Error("Herdr command failed; no local fallback"); }
  };
  const version = invoke(["--version"]).trim().match(/^herdr (\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!version || (+version[1] === 0 && (+version[2] < 9 || (+version[2] === 9 && +version[3] < 5)))) throw new Error("Herdr 0.9.5 or later is required");
  const lock = bindingPath + ".lock";
  if (mode === "apply") mkdirSync(lock, { mode: 0o700 });
  try {
    return reconcileMachines(mode as "plan" | "apply" | "status", desired, bindings, invoke, next => {
      if (readJsonFile(bindingPath, true).raw !== original.raw) throw new Error("binding changed concurrently");
      const temporary = join(dirname(bindingPath), `.devnode-bindings-${randomUUID()}.json`);
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        if (readJsonFile(bindingPath, true).raw !== original.raw) throw new Error("binding changed concurrently");
        renameSync(temporary, bindingPath);
      } finally { try { unlinkSync(temporary); } catch {} }
    });
  } finally { if (mode === "apply") rmdirSync(lock); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "machine operation failed"); process.exitCode = 1; }
}
