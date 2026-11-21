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

## Remote / multi-device（#199 詳細評価）

### 接続方式の比較（公式 docs/linux/remote-access 準拠）

| Listener | 前提 | 認証/識別 | server mode | 評価 |
| --- | --- | --- | --- | --- |
| SSH (`rex -S ssh://user@host`) | sshd + `rex` on PATH or `~/.local/bin` | OS login（既存 key/agent/config 継承） | personal / shared | **推奨**。追加 daemon 不要、caller を OS account で識別 |
| Built-in Tailscale (`--tailscale`) | Tailscale account、MagicDNS+HTTPS certs | tailnet device identity | personal / shared | tailnet 非参加 machine を device として参加させる方式。tagged device は `--tailscale-allow-tailnet-members` 必須 |
| Tailscale Serve (`tailnet-serve://` socket) | machine 上で Tailscale 稼働 | Tailscale identity | shared / login server のみ | `unix://` で Serve socket を listen すると caller が tailscaled account（通常 root）扱いになる**罠**あり。`tailnet-serve://` 必須。tagged device（CI等）は接続不可 |
| Tailnet address (`tailnet://:port`) | machine 上で Tailscale 稼働 | Tailscale identity | shared / login server | plain HTTP over tailnet（WireGuard で暗号化）。port 必須。tagged device も可 |
| Plain HTTP (`--allow-anonymous`) | 任意 | **なし**（全接続が full access） | 全 mode | 管理下 network + 別 VPN 前提。それ以外は危険 |
| 他 VPN + `--allow-anonymous` | WireGuard/ZeroTier/NetBird 等 | network 層のみ | 全 mode | 同上。login server は `anonymous` principal の account のみ許可 |

- `rex hosts add <label> ssh://…` で home server が host list の正本。`rex -S <label>` で remote の全 CLI がそのまま使える。Mac app も "Add Remote Host…" で `ssh://` を受け付ける
- `REX_AUTOSTART=0` が remote にあると SSH 経由の server 自動起動をしない
- Linux personal server の unix socket は logout で消え session が死ぬ → `loginctl enable-linger` が必須（persistent 運用の前提条件）
- server modes: personal（1 account）/ shared（`rex` group）/ login server（複数 OS account、accounts.jsonc + PAM）。systemd か Alpine OpenRC が必要（`rex` CLI 単体は不要）

### Windows server の結論

- testing 段階・Discord tester 限定。**personal server のみ**（shared/login server 非対応）、named pipe で login user のみ接続可
- WinGet（`Superlogical.RexServer.Preview`）/ MSI / zip。`rex server install` を手動実行（service 自動登録されない）
- preview channel のみ実質（stable は未リリース）
- 結論: **Windows-native worker を Rex host にするのは現時点で非推奨**。personal server 制約・testing 段階・Mac GUI なしの三重の制約があり、Windows/WSL の Worker は Herdr 経路維持が妥当（ADR-0021 §8 と一致）

### WSL worker を Rex host にできるか

- WSL2 は Linux として `rex` package（.deb）を install 可能 → **技術的には personal server + SSH/tailnet で Mac から到達可能な独立経路になりうる**
- 前提条件: `rex` on PATH（SSH login shell で解決できること）、`loginctl enable-linger`（WSL で systemd 有効な場合）、SSH key 認証
- ただし WSL の systemd/linger 対応は distro 依存で不確実。検証する場合は別 ticket で実機確認が必要。**今回の完了条件にはしない**（#199 non-goal どおり）

### 運用上の推奨（現時点）

- Mac = Rex native（daily driver）、Windows/WSL = Herdr（現行維持）
- 将来 Linux worker を Rex host 化する場合は SSH listener + personal server + linger が最小構成。Tailscale 系は tailnet 参加が前提のため後回しでよい
- `rex skill setup` の global install は行わない（project policy。SKILL.md に明記済み）

## Herdr との棲み分け(実測)

- 両者とも terminal multiplexer + agent lifecycle だが、Herdr は agent registry/status を持ち、Rex は block + OSC7501 protocol ベース
- Rex terminal 内では `herdr` CLI が PATH にあるため、Rex から Herdr の既存 session/agent を起動・操作可能(逆も同様)。runtime 間の必須依存は作らない
- 同一 Worker の同時所有防止は attempt record の `runtime` + fencing で行う(ADR-0021 §6)

## Sources

- https://www.superlogical.com/rex/docs/(installation, reference/cli, automate/server-api, automate/agent-skill, build/program-status, linux/remote-access, linux/installation, linux/server-modes, windows/installation, windows/running, automate/cli, automate/lua-scripts, automate/lua-events, reference/events, reference/lua)
- 実機 probe: `rex version`, `rex api list|describe`, `rex whoami`, `rex ls --json`, `rex skill status|show`, `rex block call program_status|process|title`, env(`REX_*`)
