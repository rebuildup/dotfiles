// OMP Worker の Rex program-status 報告（OSC 7501）
//
// Herdr 管理の `~/.omp/agent/extensions/herdr-omp-agent-state.ts` と同じ
// 状態機械を持つ project 管理版。transport だけが異なる: Herdr socket では
// なく、端末へ OSC 7501 escape sequence を直接書き出す。Rex は block 内の
// program_status record としてこれを保持し、`rex block call program_status`
// / `agent task --runtime rex` の observe・wait が読む。
//
// 有効化条件: worker プロセスが Rex block 内で動いていること（REX_BLOCK 等）。
// Herdr 内起動時は herdr extension が別途 --trusted-extension で読まれるため、
// この拡張は Herdr 環境では何も出力しない（enabled() が false）。
//
// 状態対応:
//   agent_start / session active -> working
//   tool approval / ask tool     -> blocked (kind=permission / question)
//   retryable error hold 中      -> working、猶予後 -> blocked（Herdr の
//                                   failureBlocked と同じ「ユーザー対応待ち」）
//   agent_end（継続なし）        -> done（promptBlock は fresh な
//                                   idle/done record を完了として受理する）
//   session_start（非 active）   -> idle
//
// `done` record は shell prompt を越えて残るため、次回 prompt との区別は
// consumer 側（rex.ts promptBlock）が送信前 snapshot との changed-set と
// record の updated_at で行う。ここでは遷移ごとに必ず再送出する。
//
// @ts-nocheck

const REX_ENV = process.env.REX_BLOCK || process.env.REX_SESSION || process.env.REX_SERVER;
// OMP marks every shell it spawns with OMPCODE=1. A nested `omp` launched from
// a parent session's shell inherits it, so that process is not the block's
// root agent and must not report its state.
const nestedOmpSession = process.env.OMPCODE === "1";

function enabled() {
  return Boolean(REX_ENV) && !nestedOmpSession;
}

const OSC = "\x1b]7501;";
const ST = "\x1b\\";

function b64(text: string): string {
  // OSC 7501 free-text values are base64 UTF-8, single-line, no control chars.
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").slice(0, 200);
  return Buffer.from(clean, "utf8").toString("base64");
}

function emit(state: string, kind?: string, msg?: string): void {
  if (!enabled()) return;
  const pairs = [`state=${state}`, "app=omp"];
  if (kind) pairs.push(`kind=${kind}`);
  if (msg) pairs.push(`msg=${b64(msg)}`);
  try {
    process.stdout.write(`${OSC}${pairs.join(":")}${ST}`);
  } catch {
    // A closed/broken stdout must never take the worker down with it.
  }
}

const retryGraceMs = 2500;
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function lastAssistantMessage(messages: unknown[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function retryableErrorMessage(event: any): string | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") return undefined;
  const errorMessage = String(assistant.errorMessage ?? "");
  if (!retryableErrorPattern.test(errorMessage)) return undefined;
  return errorMessage || "retryable provider error";
}

function askBlockedMessage(args: any): string {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const firstQuestion = questions.find((q: any) => typeof q?.question === "string");
  return firstQuestion?.question ?? "waiting for user input";
}

export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let turnDone = false;
  let blockedCount = 0;
  let blockedKind: string | undefined;
  let blockedMessage: string | undefined;
  let lastEmitted: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let rootSession = false;

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) clearTimeout(timer);
  }

  function clearPendingTimers() {
    clearTimer(retryTimer);
    retryTimer = undefined;
  }

  function publish(state: string, kind?: string, msg?: string, force = false) {
    // Never report the initial resting `idle`: a consumer snapshotting
    // program_status before the first prompt would see this startup idle as
    // a "fresh" settle and conclude the turn ended before it began. idle is
    // only meaningful as a transition away from a reported state.
    if (state === "idle" && lastEmitted === undefined) return;
    const key = `${state}|${kind ?? ""}|${msg ?? ""}`;
    if (!force && key === lastEmitted) return;
    lastEmitted = key;
    emit(state, kind, msg);
  }

  function desired(): { state: string; kind?: string; msg?: string } {
    if (blockedCount > 0) {
      return { state: "blocked", kind: blockedKind, msg: blockedMessage };
    }
    if (failureBlocked) {
      return { state: "blocked", msg: "worker stopped on provider error" };
    }
    if (agentActive || retryHoldActive) {
      return { state: "working" };
    }
    if (turnDone) {
      return { state: "done" };
    }
    return { state: "idle" };
  }

  function publishDesired(force = false) {
    const d = desired();
    publish(d.state, d.kind, d.msg, force);
  }

  function holdForRetry() {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    publishDesired(true);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishDesired(true);
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  function activateRootSession(ctx: any): boolean {
    if (ctx?.hasUI !== true) return false;
    rootSession = true;
    publishDesired(true);
    return true;
  }

  function resetSessionState() {
    clearPendingTimers();
    retryHoldActive = false;
    failureBlocked = false;
    agentActive = false;
    turnDone = false;
    blockedCount = 0;
    blockedKind = undefined;
    blockedMessage = undefined;
  }

  function activateBlocked(kind: string | undefined, message: string | undefined) {
    clearPendingTimers();
    blockedCount += 1;
    blockedKind = kind;
    blockedMessage = message;
    publishDesired();
  }

  function deactivateBlocked() {
    blockedCount = Math.max(0, blockedCount - 1);
    if (blockedCount === 0) {
      blockedKind = undefined;
      blockedMessage = undefined;
    }
    publishDesired();
  }

  pi.on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    agentActive = ctx?.isIdle?.() === false;
    if (!agentActive) turnDone = false;
    publishDesired(true);
  });

  pi.on("session_switch", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    resetSessionState();
    publishDesired(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    clearPendingTimers();
    retryHoldActive = false;
    failureBlocked = false;
    turnDone = false;
    agentActive = true;
    publishDesired(true);
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    const label = event?.reason || `${event?.toolName || "Tool"} approval`;
    activateBlocked("permission", label);
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    deactivateBlocked();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "ask") return;
    if (!rootSession && !activateRootSession(ctx)) return;
    activateBlocked("question", askBlockedMessage(event.args));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask") return;
    if (!rootSession && !activateRootSession(ctx)) return;
    deactivateBlocked();
  });

  pi.on("agent_end", (event) => {
    if (!rootSession) return;
    if (!agentActive) return;
    if (event?.willContinue === true) return;

    agentActive = false;

    if (retryableErrorMessage(event)) {
      holdForRetry();
      return;
    }

    // A completed turn is "done", not "idle": the result is ready and the
    // record survives shell prompts, so observe/wait can still see it. It is
    // sticky until the next agent_start, so a stray publishDesired cannot
    // downgrade it back to idle mid-turn.
    clearPendingTimers();
    retryHoldActive = false;
    failureBlocked = false;
    turnDone = true;
    publishDesired(true);
  });

  pi.on("session_shutdown", () => {
    if (rootSession) clearPendingTimers();
  });
}
