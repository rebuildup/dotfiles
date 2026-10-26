import { expect, test } from "bun:test";
// Removing binding identity checks must make these tests fail; Herdr itself is not under test.
const module = await import("./devnode-machines.ts").catch(() => ({})) as any;
const desired = { version: 1, machines: [{ name: "win-uuu", label: "UUU · Windows" }, { name: "mac", label: "Mac · macOS" }] };
const binding = { version: 1, bindings: [{ name: "win-uuu", profileId: "e310d40031e946d9896f29d9f600d317", target: "devnode-win-uuu-recreated", session: "devnode-poc-win-20261026", expectedLabel: "old-poc" }] };
const current = [{ id: "e310d40031e946d9896f29d9f600d317", target: "devnode-win-uuu-recreated", session: "devnode-poc-win-20261026", label: "old-poc", enabled: true, selected: false }, { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", target: "wsl-ubuntu", session: "default", label: "Ubuntu", enabled: true, selected: false }];
function planner(...args: any[]) { expect(module.planMachines).toBeFunction(); return module.planMachines(...args); }
test("plans only explicitly bound profiles and leaves unrelated Ubuntu alone", () => {
  const plan = planner(desired, binding, current);
  expect(plan.changes).toEqual([{ name: "win-uuu", profileId: "e310d40031e946d9896f29d9f600d317", target: "devnode-win-uuu-recreated", session: "devnode-poc-win-20261026", from: "old-poc", to: "UUU · Windows" }]);
  expect(plan.unbound).toEqual(["mac"]);
  expect(current[1].label).toBe("Ubuntu");
});
test("already desired owned label is idempotent after a partial rename", () => {
  const profiles = structuredClone(current); profiles[0].label = "UUU · Windows";
  expect(planner(desired, binding, profiles).changes).toEqual([]);
  expect(planner(desired, binding, profiles).unchanged).toEqual(["win-uuu"]);
});
test("refuses replaced endpoint or session even when ID and label still match", () => {
  for (const update of [{ target: "attacker" }, { session: "default" }, { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, { label: "someone-elses-edit" }]) {
    const profiles = structuredClone(current); Object.assign(profiles[0], update);
    expect(() => planner(desired, binding, profiles)).toThrow();
  }
});
test("a desired label on a foreign profile cannot be silently adopted", () => {
  const profiles = structuredClone(current); profiles[1].label = "UUU · Windows";
  expect(() => planner(desired, binding, profiles)).toThrow();
});
test("rejects duplicate keys, IDs, desired labels and unrecognized secret-shaped fields", () => {
  for (const bad of [
    { ...desired, machines: [...desired.machines, desired.machines[0]] },
    { ...desired, machines: [{ name: "win-uuu", label: "same" }, { name: "mac", label: "same" }] },
    { ...desired, token: "never-accepted" },
    { ...desired, machines: [{ name: "win-uuu", label: "bad\nlabel" }] },
  ]) expect(() => planner(bad, binding, current)).toThrow();
  for (const bad of [
    { ...binding, bindings: [...binding.bindings, binding.bindings[0]] },
    { ...binding, bindings: [{ ...binding.bindings[0], name: "not-in-desired" }] },
    { ...binding, bindings: [{ ...binding.bindings[0], password: "never-accepted" }] },
  ]) expect(() => planner(desired, bad, current)).toThrow();
});

test("apply changes the owned catalog entry, persists its expected label, and remains a noop next time", () => {
  expect(module.reconcileMachines).toBeFunction();
  const catalog = structuredClone(current);
  let saved: any;
  const invoke = (args: string[]) => {
    if (args.join(" ") === "machine list --json") return JSON.stringify(catalog);
    if (args[0] === "machine" && args[1] === "rename" && args[2] === catalog[0].id && args[3] === "--label") { catalog[0].label = args[4]; return "renamed"; }
    throw new Error("unexpected remote mutation");
  };
  const first = module.reconcileMachines("apply", desired, binding, invoke, (next: any) => { saved = next; });
  expect(first.applied).toEqual(["win-uuu"]);
  expect(catalog[0].label).toBe("UUU · Windows");
  expect(catalog[1]).toEqual(current[1]);
  expect(saved.bindings[0].expectedLabel).toBe("UUU · Windows");
  expect(module.reconcileMachines("apply", desired, saved, invoke, () => {}).applied).toEqual([]);
});
test("all bindings are validated before the first rename and errors are not reported as complete", () => {
  expect(module.reconcileMachines).toBeFunction();
  const catalog = structuredClone(current); catalog[0].session = "default";
  const invoke = (args: string[]) => { if (args.join(" ") === "machine list --json") return JSON.stringify(catalog); throw new Error("must not mutate"); };
  expect(() => module.reconcileMachines("apply", desired, binding, invoke, () => { throw new Error("must not persist"); })).toThrow("drift");
});

import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.skipIf(process.platform === "win32")("CLI plan/apply updates only the owned label and binding file across separate processes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "machine-cli-")));
  try {
    const config = join(root, "desired.json"), bindings = join(root, "bindings.json"), catalog = join(root, "catalog.json"), fake = join(root, "herdr");
    writeFileSync(config, JSON.stringify(desired)); writeFileSync(bindings, JSON.stringify(binding), { mode: 0o600 }); writeFileSync(catalog, JSON.stringify(current));
    writeFileSync(fake, `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';const a=process.argv.slice(2),p=${JSON.stringify(catalog)};if(a[0]==='--version')console.log('herdr 0.9.5');else if(a.join(' ')==='machine list --json')console.log(readFileSync(p,'utf8'));else if(a[0]==='machine'&&a[1]==='rename'&&a[3]==='--label'){const c=JSON.parse(readFileSync(p,'utf8'));const x=c.find(x=>x.id===a[2]);if(!x)process.exit(1);x.label=a[4];writeFileSync(p,JSON.stringify(c));}else process.exit(2);\n`, { mode: 0o700 });
    const run = (mode: string) => Bun.spawnSync([process.execPath, join(import.meta.dir,"devnode-machines.ts"), mode, "--bindings", bindings, "--config", config, "--herdr", fake]);
    const plan = run("plan"); expect(plan.exitCode).toBe(0); expect(JSON.parse(plan.stdout.toString()).changes).toHaveLength(1);
    expect(JSON.parse(readFileSync(catalog, "utf8"))[0].label).toBe("old-poc");
    const applied = run("apply"); expect(applied.exitCode).toBe(0); expect(JSON.parse(applied.stdout.toString()).applied).toEqual(["win-uuu"]);
    expect(JSON.parse(readFileSync(bindings,"utf8")).bindings[0].expectedLabel).toBe("UUU · Windows");
    expect(JSON.parse(readFileSync(catalog,"utf8"))[1]).toEqual(current[1]);
    const again = run("apply"); expect(again.exitCode).toBe(0); expect(JSON.parse(again.stdout.toString()).applied).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("CLI rejects unknown/duplicate options and missing explicit bindings without invoking a binary", () => {
  for (const args of [["apply"], ["apply", "--bindings", "/missing", "--herdr", "/not-called", "--password", "no"], ["plan", "--bindings", "/missing", "--bindings", "/other", "--herdr", "/not-called"]]) {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir,"devnode-machines.ts"), ...args]);
    expect(result.exitCode).not.toBe(0); expect(result.stdout.toString()).toBe("");
  }
});

test.skipIf(process.platform === "win32")("CLI refuses a private binding in a foreign-writable parent before invoking Herdr", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "machine-parent-")));
  try {
    const config=join(root,"desired.json"), bindings=join(root,"bindings.json"), fake=join(root,"herdr");
    writeFileSync(config,JSON.stringify(desired));writeFileSync(bindings,JSON.stringify(binding),{mode:0o600});
    writeFileSync(fake,`#!${process.execPath}\nconsole.log('herdr 0.9.5');\n`,{mode:0o700});
    chmodSync(root,0o777);
    const result=Bun.spawnSync([process.execPath,join(import.meta.dir,"devnode-machines.ts"),"plan","--bindings",bindings,"--config",config,"--herdr",fake]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("binding parent");
  } finally { chmodSync(root,0o700);rmSync(root,{recursive:true,force:true}); }
});

test.skipIf(process.platform !== "win32")("Windows binding guard accepts owner-only resources and refuses another principal's write access", () => {
  const root = mkdtempSync(join(tmpdir(), "machine-acl-"));
  const setup = join(root, "setup.ps1"), parent = join(root, "private"), bindings = join(parent, "bindings.json");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    writeFileSync(setup, `param([string]$Root,[string]$Mode)\n$ErrorActionPreference='Stop'\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value\nif($Mode -eq 'private'){New-Item -ItemType Directory -Path $Root | Out-Null; [IO.File]::WriteAllText((Join-Path $Root 'bindings.json'),'{}'); & icacls.exe $Root /inheritance:r /grant:r "*$($sid):(OI)(CI)F" | Out-Null; if($LASTEXITCODE){exit 1}; & icacls.exe $Root /setowner "*$sid" /t | Out-Null; if($LASTEXITCODE){exit 1}}else{& icacls.exe $Root /grant '*S-1-1-0:(OI)(CI)M' | Out-Null; if($LASTEXITCODE){exit 1}}\n`);
    const setupResult = Bun.spawnSync([powershell,"-NoProfile","-NonInteractive","-File",setup,"-Root",parent,"-Mode","private"]);
    expect(setupResult.exitCode).toBe(0);
    const check = () => Bun.spawnSync([powershell,"-NoProfile","-NonInteractive","-File",join(import.meta.dir,"devnode-bindings-acl.ps1"),"-LiteralPath",bindings]);
    const good = check(); expect(good.exitCode).toBe(0); expect(good.stdout.toString().trim()).toBe("private-binding-acl-ok");
    expect(Bun.spawnSync([powershell,"-NoProfile","-NonInteractive","-File",setup,"-Root",parent,"-Mode","unsafe"]).exitCode).toBe(0);
    expect(check().exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
