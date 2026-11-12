# Agent Router E2E Verification Evidence

**Date**: 2026-11-12
**SHA**: c22473d (release-0-4-0) + agent.e2e.test.ts
**Host**: WSL2 Linux 6.18.58.1-microsoft-standard-WSL2, x64, Bun 1.4.2

## Scope

Real-machine E2E verification of the agent launcher, Herdr integration,
attempt fencing, and recovery state machine. Billing/provider response
tests are EXCLUDED (no live provider calls without explicit authorization).

## Verified (REAL, this host)

| Check | Result | Evidence |
|---|---|---|
| `agent check` config validation | ✅ PASS | 8 providers, 5 harnesses, 19 routes |
| `agent list` route listing | ✅ PASS | omp, claude, opencode, dsh, vibe |
| `agent routes --json` | ✅ PASS | valid JSON with routes |
| `agent fallback omp-mistral-quota` | ✅ PASS | profile resolves, candidates shown |
| Unknown route rejection (exit 2) | ✅ PASS | fails closed |
| Unknown model rejection (exit 2) | ✅ PASS | fails closed |
| Unknown fallback profile rejection | ✅ PASS | fails closed |
| Herdr CLI available (0.9.5) | ✅ PASS | `herdr --version` returns version |
| Herdr workspace list JSON | ✅ PASS | valid JSON with workspaces array |
| Herdr agent list JSON | ✅ PASS | valid JSON with agents array |
| FsAttemptStore create/read | ✅ PASS | record persisted, generation matches lease |
| Recovery plan convergence | ✅ PASS | alive attempt → waiting/reconcile-remote-state |
| Secret leak in `agent check` | ✅ PASS | no ghp_/sk-/AKIA patterns |
| Secret leak in `agent routes --json` | ✅ PASS | no ghp_/sk-/AKIA patterns |

## Structural verification (via Herdr, Mac machine)

| Check | Result | Evidence |
|---|---|---|
| Mac machine reachable | ✅ PASS | `herdr machine status` shows Mac reachable |
| Mac agents running | ✅ PASS | 11 agents active (opencode, omp) |
| Mac workspace list | ✅ PASS | FlashBeat, ae-a8n, Aulymo_v04, tastile-core, etc. |

## UNVERIFIED (explicitly not claimed)

| Check | Reason | Blocker |
|---|---|---|
| **Actual provider response + tool call** | Requires billing/credentials | No billing authorization |
| **Quota error + recovery (real)** | Requires real provider 429/402 | No billing authorization |
| **Windows native CLI** | Herdr remote server stopped | `herdr --remote device-windows` not running |
| **macOS native CLI** | Structural only via Herdr | No direct macOS shell access |
| **Herdr pane detach/recovery round-trip** | Not exercised | Requires live agent lifecycle test |
| **Cross-machine result** | Not exercised | Requires 2+ machines with real work |
| **Offline/reconnect/host reboot** | Not exercised | Requires controlled network/host failure |
| **Windows+WSL physical sharing** | Not exercised | Windows Herdr server stopped |

## CI Evidence

- **push run**: all 3 OS green (Ubuntu/macOS/Windows)
- **pull_request run**: `./script/test` fails on missing `home/snippets/` (pre-existing, release branch lacks snippets dir added to main later)
- **Full test suite**: 695 pass / 17 skip / 0 fail (2513 assertions, 24 files)

## Known Limitations

1. **No billing**: actual provider response, tool call, quota error, and
   cross-machine result cannot be verified without explicit billing
   authorization. All provider-facing tests are mock/fixture only.
2. **Windows blocked**: Herdr remote server for Windows is stopped.
   Starting it requires user action: `herdr --remote device-windows --session default`.
3. **Herdr `machine status` timeout**: the command sometimes exceeds 3s
   timeout in CI/test environments; tests skip with explicit reason.
4. **pull_request CI failure**: pre-existing `./script/test` failure due to
   missing `home/snippets/` on release branches. Not caused by agent
   launcher changes. Push runs (which run agent tests) are green.

## Conclusion

Structural verification (launcher, config, fencing, recovery, Herdr API,
secret handling) is COMPLETE on WSL/Linux with Herdr structural checks on
Mac. Real provider E2E, Windows native, and lifecycle round-trips remain
UNVERIFIED pending billing authorization and Windows Herdr server recovery.
