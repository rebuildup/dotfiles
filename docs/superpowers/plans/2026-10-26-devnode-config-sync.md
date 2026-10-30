# Devnode configuration sync implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans, preserving the existing Mac integration/Windows provisioning ownership split.

**Goal:** Non-secret Git updates and readable Herdr machine labels can be applied independently on each node, while Windows continues isolated WSL enrollment.

**Architecture:** dotfiles owns a bounded Git update entrypoint and desired display configuration; machine-local bindings preserve SSH trust and client profile ownership. Herdr official CLI owns all catalog mutations. pc-setup owns OS prerequisites and persistent services.

**Tech Stack:** Existing Bun 1.4.2/TypeScript, Git, Herdr 0.9.5; no new dependency.

**Spec:** docs/adr/distributed-development-nodes.md (approved design, Git同期と表示名の具現化).

## Global constraints

- Canonical origin is https://github.com/rebuildup/dotfiles.git (equivalent SSH origin allowed); explicit branch, clean checkout, fast-forward only.
- No key/token/cache/session/known_hosts synchronization, no reset/stash/clean/merge commit, no default-session changes.
- Display config is a connection presentation layer, not an authentication/node registry.
- Bindings must match official profile ID, SSH target, remote session and expected old/current label; no implicit adoption.
- Existing Ubuntu/Ubuntu2 and unrelated files must remain intact.

## Review focus

- Dirty/untracked or diverged checkout: refuse apply, keep local files/history.
- Unexpected origin/ref/option-shaped arguments: reject before remote fetch or mutation.
- Duplicate desired label/key or foreign binding: fail before any catalog change.
- Partial rename failure: preserve truthful journal; rerun accepts already-desired owned profile, no repeated unrelated mutation.
- Same name on another instance: never infer identity or grant access from display name.

### Task 1: Bounded Git update

Files: script/devnode-update.ts, script/devnode-update.test.ts. Consumes CLI argv; produces exported runUpdate({repo,branch,mode}) and direct CLI check/apply. Tests use local temporary Git remotes to prove dirty/diverged rejection and fast-forward without data loss; production origin restriction remains strict, test runner may pass an explicit allowed-origin dependency rather than environment bypass.

- [ ] Write and observe RED for clean fast-forward, dirty/untracked refusal, divergence, wrong branch/origin and invalid branch/argv.
- [ ] Implement minimal check/apply and JSON current/target/changed/noop output; no install or secret access.
- [ ] Run tests GREEN, then independent review. Parent integrates dispatcher after public interface confirmation.

### Task 2: Owned display-name reconciliation

Files: config/devnode-machines.json, script/devnode-machines.ts, script/devnode-machines.test.ts; modify script/devnode.ts dispatch and mise description/docs.

Interface: desired {version:1,machines:[{name,label}]}; private binding {version:1,bindings:[{name,profileId,target,session,expectedLabel}]}. plan/apply/status consume official machine list JSON and explicit Herdr binary. Only apply invokes rename with opaque profile ID. No profile add/remove.

- [ ] Write RED tests for idempotence, target/session drift, duplicate/foreign IDs, unknown names and ambiguous desired labels; test CLI errors do not launch Herdr.
- [ ] Implement strict schemas and pure planner plus official CLI adapter; avoid shell command interpolation.
- [ ] Run GREEN and integration tests against isolated fake CLI; use actual owned Mac profile for plan/apply/noop/status proof.

### Task 3: Remote adoption and delivery

- [ ] Publish immutable source SHA to branch74/PR75; Windows fetches dedicated checkout (no existing checkout reset).
- [ ] Run Windows/Linux parser/update tests and apply only reviewed private bindings; record actual OS/version/SHA.
- [ ] Add new isolated WSL only after Windows owner supplies verified SSH endpoint/pin and official Herdr profile; never treat clone/update as enrollment.
- [ ] Record Japanese operation/recovery commands, local gates and CI; keep unfinished WSL/service/MI requirements explicit.


## Execution ledger

- Task 1 implementer stopped on usage limit after writing updater/tests; Mac integration took ownership. Root observed 8 tests passing, then added a real ignored-file overwrite regression: RED (Git overwrote the local ignored file) → `--no-overwrite-ignore` → GREEN 9 tests. No claim that the earlier 8 tests had a root-observed RED run.
- Ruling: use Git's verified-SHA `merge --ff-only` as the fast-forward mechanism. The prohibition is merge commits/PR landing; read-tree/update-ref custom choreography would be less safe. Hooks and autostash remain disabled.
- Task 2 planner RED 2fail→GREEN5; adapter RED2fail→GREEN7. CLI/disk integration and remote adoption pending.
- 2026-10-26 security steering: prioritize official Tailscale/Headscale advisories and actual feature exposure. Windows1.102.4 update underway, Mac1.104.2/RunSSHfalse/Serveempty. Headscale0.29.6 already memory512MiB/pids128/restartsupervised/DERPoff; do not imply Tailworm fixed.
