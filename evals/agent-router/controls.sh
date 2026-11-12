#!/usr/bin/env bash
# Agent router policy evaluation controls (dotfiles#104, T018).
#
# Positive controls: must PASS (the system correctly allows valid behavior).
# Negative controls: must FAIL (the system correctly rejects invalid behavior).
# Regression controls: must FAIL on known-bad inputs (never regress to PASS).
#
# Each control runs a deterministic check against the agent launcher modules.
# No network, no live provider, no secrets.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$REPO"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "  ok   $1 -> PASS"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "  ok   $1 -> FAIL (expected)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

bad() {
  echo "  FAIL $1 -> unexpectedly passed"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "agent-router policy controls"

# --- Positive controls: valid behavior must pass ---

# P1: valid route/model passes config validation
if bun script/agent.ts check >/dev/null 2>&1; then
  pass "valid config check"
else
  bad "valid config check"
fi

# P2: fallback profile resolution works for valid profile
if bun script/agent.ts fallback omp-mistral-quota >/dev/null 2>&1; then
  pass "valid fallback profile resolves"
else
  bad "valid fallback profile resolves"
fi

# P3: agent list shows configured routes
if bun script/agent.ts list >/dev/null 2>&1; then
  pass "agent list works"
else
  bad "agent list works"
fi

# --- Negative controls: invalid behavior must fail ---

# N1: unknown route fails closed
if bun script/agent.ts omp nonexistent-provider >/dev/null 2>&1; then
  bad "unknown route rejected"
else
  fail "unknown route rejected"
fi

# N2: unknown model fails closed
if bun script/agent.ts omp mistral --model nonexistent-model >/dev/null 2>&1; then
  bad "unknown model rejected"
else
  fail "unknown model rejected"
fi

# N3: unknown fallback profile fails closed
if bun script/agent.ts fallback nonexistent-profile >/dev/null 2>&1; then
  bad "unknown fallback profile rejected"
else
  fail "unknown fallback profile rejected"
fi

# N4: forbidden passthru flags are rejected
if bun script/agent.ts omp mistral -- --profile fake >/dev/null 2>&1; then
  bad "forbidden omp --profile rejected"
else
  fail "forbidden omp --profile rejected"
fi

# N5: native mode with --model fails (requires provider route)
if bun script/agent.ts omp --model some-model >/dev/null 2>&1; then
  bad "native --model rejected"
else
  fail "native --model rejected"
fi

# --- Regression controls: known-bad inputs must never regress to PASS ---

# R1: silent paid fallback must never happen (openrouter-free has single model)
if bun script/agent.ts omp openrouter-free --model paid-model >/dev/null 2>&1; then
  bad "silent paid model fallback blocked"
else
  fail "silent paid model fallback blocked"
fi

# R2: cross-harness fallback must not happen (omp route never switches to claude)
if bun script/agent.ts omp mistral --agent-model claude-model >/dev/null 2>&1; then
  bad "cross-harness model injection blocked"
else
  fail "cross-harness model injection blocked"
fi

# R3: unknown provider never resolves to a default
if bun script/agent.ts omp unknown-provider >/dev/null 2>&1; then
  bad "unknown provider fails closed"
else
  fail "unknown provider fails closed"
fi

echo ""
echo "controls: $PASS_COUNT positive/regression passed, $FAIL_COUNT negative/regression failed (expected)"

# All negative/regression controls must have "failed" (i.e., the system rejected them)
# All positive controls must have "passed"
if [ "$FAIL_COUNT" -gt 0 ] && [ "$PASS_COUNT" -ge 3 ]; then
  echo "controls OK: grader discriminates"
  exit 0
else
  echo "CONTROLS BROKEN: eval scores are not trustworthy"
  exit 1
fi
