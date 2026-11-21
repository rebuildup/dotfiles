# Rex integration research — 2026-11-21

調査日: 2026-11-21。対象: dotfiles#194/#199。実機: macOS (arm64)、Rex
`0.1.0-preview.21` (commit `202b1b3`, built 2026-11-17)、server API revision 18。

## Installed state

- `rex` binary: `/Users/rebui/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`(Mac app 同梱、mise 管理外)
- Server: 起動中、`unix:///Users/rebui/Library/Application Support/rex/server.sock`、pid 71643、identity `rebui` (uid 501)
- Sessions observed: `Onboarding`, `calm-cliff`(本 agent の実行セッション)
- 環境変数: `REX_SESSION`, `REX_BLOCK`, `REX_SERVER`, `TERM_PROGRAM=rex` が Rex terminal 内で設定される

## Execution model

- 階層: server → session → window(tab 相当) → block(pane/terminal 相当)。block type は `com.superlogical.terminal` 等、`rex block types --json` で列挙
- 主要 CLI: `new` / `ls` / `run` / `split` / `window new|ls|inspect|close` / `block ls|inspect|close|call` / `send` / `send-key` / `capture` / `kill` / `wait` / `events` / `api list|describe|call` / `do`(Lua) / `forward` / `hosts` / `server` / `skill`
- `run`/`split`/`window new` は `--json` で `session_id`/`window_id`/`block_ids` を返す。block は login shell の環境で起動(`--interactive` で rc も読む、`--shell=none` で直接実行)。`--env` 相当の flag は**ない**
- `send` は text 注入、`send-key` は key press(US layout 解釈)。`capture` は screen+scrollback(~64MiB)、`--format=vt|html|text`、`--trim`
- `wait TARGET --for DURATION --json`: block(terminal)なら child exit status、window/session なら close/destroy。`--timeout` は接続/request のみで event stream は制限しない
- `events [--all|--json]`: session 作成/削除/state 変更等を stream
- `api`: `session.*`(create/list/view/attach/detach/new_window/new_split/new_block/set_label/…), `block.*`, `client.*`, `server.*`, `hosts.*`, `com.superlogical.terminal.*`(format/pwd/title/process/program_status/modes/write/…)。`api describe` が JSON Schema + example を返す
- block method `com.superlogical.terminal.process`: foreground process(pid/name/cwd)、`last_exit` を返す。`title`/`pwd`/`modes`(alternate screen 判定)も利用可

## Agent state: OSC 7501 Program Status Protocol

- program が `ESC ] 7501 ; state=…:kind=…:app=…:msg=<base64> ST` を terminal へ出力すると server が記録
- state: `idle|working|done|blocked|error|clear`。kind(blocked 時): `permission|question|auth`
- 観測: `rex block call -b BLOCK program_status` → `records[]`(state/app/msg/owner.pid 等)。event: `terminal.program_status_changed`
- 実測: 本 session の Devin CLI が `state=working, app=devin` を報告済み → protocol は実際に機能する
- OMP/Claude Code/Codex/OpenCode が emit するかは未確認 → #197 で project-managed OMP extension を用意する方針(ADR-0021 §9)

## Automation surface

- `rex do`: action 実行 or Lua script(`-e`/path/`-` stdin)。`rex.on`/`rex.wait`/`rex.sleep`/`rex.call`/`rex.session.*`/`rex.block.call`/`rex.servers()`/`rex.server(LABEL)`(remote host)
- `rex skill setup|status|remove|show`: agent 検出(claude/codex/opencode/pi)へ skill(`~/.claude/skills/rex`, `~/.agents/skills/rex`)と hook(claude:settings.json, codex:hooks.json)を導入。opencode/pi は hook 非対応。`--project` で repo 単位、`--dry-run`/`--agent`/`--force`/`--session-naming`/`--json`
- 現状 `rex skill status`: 全 agent で skill/hook `missing`(global install は未実施 — project policy により必須としない)

## Remote / multi-device

- `rex hosts`: home server が host list の正本。`rex -S <label|ssh://…>` で remote server の全 CLI がそのまま使える
- `rex -S ssh://user@host`: server の `ssh` を利用、既存 key/agent/config を継承。remote で `rex` が PATH 上 or `~/.local/bin` に必要
- Linux server: `rex server install`(boot 自動起動)。mode: personal / shared(rex group) / login server(複数 OS account)。socket は default で unix のみ listen
- remote listener: SSH(推奨、caller を OS login で識別)/ built-in Tailscale(`--tailscale`)/ Tailscale Serve(`tailnet-serve://` socket)/ tailnet address(`tailnet://:port`)/ plain HTTP(`--allow-anonymous`、危険)/ 他 VPN
- 注意: personal server の unix socket は logout で消え session が死ぬ → `loginctl enable-linger` が必要
- Windows server: testing 段階、WinGet/MSI/zip、personal server のみ(named pipe、login server/shared 非対応)。`rex server install` を手動実行。preview channel のみ実質
- 既存 Herdr machines(WSL/Windows worker)への適用: WSL/Linux なら personal server + SSH or tailnet で候補になるが、worker の OS account/linger/`rex` on PATH の確認が前提。Windows worker は personal server 前提で制約が大きい。当面 Herdr 経路維持(ADR-0021 §8)

## Herdr との棲み分け(実測)

- 両者とも terminal multiplexer + agent lifecycle だが、Herdr は agent registry/status を持ち、Rex は block + OSC7501 protocol ベース
- Rex terminal 内では `herdr` CLI が PATH にあるため、Rex から Herdr の既存 session/agent を起動・操作可能(逆も同様)。runtime 間の必須依存は作らない
- 同一 Worker の同時所有防止は attempt record の `runtime` + fencing で行う(ADR-0021 §6)

## Sources

- https://www.superlogical.com/rex/docs/(installation, reference/cli, automate/server-api, automate/agent-skill, build/program-status, linux/remote-access, linux/installation, windows/installation, automate/cli, automate/lua-scripts, automate/lua-events, reference/events, reference/lua)
- 実機 probe: `rex version`, `rex api list|describe`, `rex whoami`, `rex ls --json`, `rex skill status|show`, `rex block call program_status|process|title`, env(`REX_*`)
