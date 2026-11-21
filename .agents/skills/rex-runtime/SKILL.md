---
name: rex-runtime
description: Rexをoptional Supervisor/session Practiceとして使い、Worker execution attemptの安全なmapping・観測・停止・復旧と、Herdrとの併用境界を扱う時に使用する。
---

# Rex Runtime

Layer: **Practice**（project-local。upstream-managed ではないため `skills-lock.json` には登録しない。`skills update` で消えた場合はこのファイルを正本として復元する）

RexはHerdrと並列の第2のagent execution runtimeである（ADR-0021）。Herdrの置換ではなく、Mac上でのGUI操作・session管理・OSC 7501 program-status観測を提供する独程経路。Windows/WSLのWorkerは当面Herdr経路を維持する。

## When to use

- Mac上でRex GUIからsessionを直接監視・操作したい
- `agent task run --runtime rex` でWorkerをdispatchし、block単位でobserve/wait/collectしたい
- Rex block内から既存Herdr CLI（`herdr agent list/prompt/read` 等）を使ってHerdr sessionを操作したい
- OSC 7501対応program（OMP + `rex-omp-agent-state.ts` extension等）のstatusをterminal経由で観測したい

次の場合はRexへ昇格させない:

- Windows/WSL hostのWorker（Rex serverの非Mac対応は未検証。#199）
- Herdrが既にcanonicalなdurable task stateを持つattemptの途中乗り換え（runtimeはattempt記録値に固定。暗黙のcross-runtime fallbackは存在しない）

## Preconditions

- `rex` CLIがPATH上にある（`agent task run --runtime rex` はavailability checkでfail closed）
- Rex serverが起動している（`rex ls` が応答する）
- OMP workerのprogram-statusが必要な場合、worker argvに `--trusted-extension script/rex-omp-agent-state.ts` が含まれること（`agent task --runtime rex` は自動付与）

block内では `REX_BLOCK` / `REX_SESSION` / `REX_SERVER` が設定される。interactiveにRex内で `agent omp ...` を起動した場合も同extensionが有効になる。

## Responsibility split

| Layer | Responsibility |
| --- | --- |
| project-init | work unit / attempt class / authority / evidence / admission / recovery semantics |
| Worktrunk or selected Git workspace Practice | branch/worktree materialization |
| sandbox/runtime | filesystem/process/service/network/credential mutable ownership |
| Rex | session/window/block、terminal、block lifecycle、OSC 7501 program_status、transient state/observability |
| Herdr | 従来通りのworkspace/pane/agent lifecycle（変更なし・default runtime） |

## Mapping

`agent task` のruntime adapter契約に対応するRex側のshape:

| Logical capability | Rex Practice |
| --- | --- |
| create execution surface | `rex new`（session）+ window/block |
| spawn Worker agent | block内でharness argvを直接実行（`--` 以降のargv） |
| discover/observe | `rex block ls` / `block inspect` / `block call program_status` / `block call process` |
| send work | `rex send`（text）+ `rex send-key enter` |
| wait | `block call program_status` のfresh record遷移 / `rex wait --for` |
| inspect result/UI | `rex capture`（raw terminal output。parse済みagent textではない） |
| teardown | `rex block close` / `rex window close` / `rex kill <session>` |

Herdrの `agent prompt/wait/read/attach` 相当は **Rex block API経由**で行い、Herdr CLIを経由しない。逆にRexからHerdrを使う場合はHerdr正規CLI（`herdr ...`）をblock内shellから呼ぶ。両runtimeが同一Workerを同時所有しない: worker identityはruntime-scoped（Herdr=agent name、Rex=block ID）で、attempt recordの `runtime` が唯一の正本。

## Ownership / fail-closed rules

- `TaskAttempt.runtime` が `"herdr"` / `"rex"` を記録する。欠落はherdr（後方互換）、未知値はContractErrorでfail closed
- resume/reconcileはattempt記録のruntimeだけをprobeする。probeが `unknown`（CLI欠落・transport障害・server障害・malformed出力）ならworker不在とみなさずpendingのまま残す
- `inspectBlockPresence` の `"absent"`（serverが明示的にnot found）のみがworker消失の証拠
- OSC 7501の `done`/`idle` recordはstaleになりうる。`promptBlock` は送信前snapshotを取り、changed record set（`updated_at`含む）のみを新promptの結果として受理する
- credentialはworker argvに載せない。`env NAME=VALUE` prefixは非secret値のみ

## Herdr coexistence

- 既定runtimeはherdrのまま。`--runtime` 省略時の挙動は不変
- `agent task run --runtime rex` はHerdrに一切触れない（surfaceもmappingも別namespace: `rex-tasks/` vs `herdr-tasks/`）
- Herdr停止中でもRex経路は独立して完走する。Rex GUIがMac限定の間、Windows/WSLはHerdr経路を使い続ける
- OMP workerにはruntimeに応じて Herdr extension（HERDR_ENV内）またはRex status extension（REX_* env内）のみが状態報告する。両方が同時に有効になることはない

## `rex skill setup` の方針

`rex skill setup` が各agent（claude/codex等）へinstallするskill/hookは **global（`~/.claude` 等）へは入れず、project-localまたは実施最小限**とする。Rexのagent skillはRex GUI連携用の補助であり、dotfilesのcanonical管理（project-init skills + `skills-lock.json`）を置き換えない。導入する場合は `--dry-run` で影響範囲を確認し、変更は別commitでreviewする。
