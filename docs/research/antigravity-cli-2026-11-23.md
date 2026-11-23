# Antigravity CLI (agy) 実機調査メモ — 2026-11-23

Issue #218 の実装根拠。対象マシン: macOS arm64、agy 1.5.14
（`~/.local/bin/agy` スタンドアロンおよび mise aqua 1.5.14、同一バイナリサイズ）。

## 実行ファイル・バージョン・PATH

- `which agy` → `/Users/rebui/.local/bin/agy`（mise 管理前）。mise 側は
  `~/.local/share/mise/shims/{agy,antigravity}` と
  `~/.local/share/mise/installs/agy/1.5.14/{agy -> antigravity}`。
- PATH では `~/.local/bin` が mise shims より前にあるため、mise 導入後も
  スタンドアロンバイナリが残ると shim が隠れる。退避が必須。

## 認証状態（秘密情報を含まない範囲で確認）

- `agy models` / `agy -p` は SSH 環境変数ありだと
  `Using file-based token storage because SSH session detected` をログに出し、
  `~/.gemini/antigravity-cli/antigravity-oauth-token` を探して未ログイン扱い。
- `env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY agy models` で keyring 認証が
  成功しモデル一覧を取得（Google アカウントのサブスクリプション認証）。
- キーチェーンには `svce=gemini` / `acct=antigravity` の項目あり（値は未読）。
- `agy acp` の `initialize` 応答 `authMethods`:
  `oauth-personal`（Google アカウント）、`oauth-business`（Gemini Enterprise）、
  `gemini-api-key`、`agent-platform`。本件は `oauth-personal` のみ使用。

## 非対話実行・構造化出力・画像入力

- `agy -p "..."` : 応答テキストを stdout へ返す。`--print-timeout` で制限可。
- `--output-format json` : `conversation_id` / `status` / `response` /
  `duration_seconds` / `num_turns` / `usage{input,output,thinking,
  cache_read,total}_tokens` / `denied_actions` を返す。
- `--json-schema <schema>` : structured output を強制（stream-json では最終結果のみ）。
- 画像入力: プロンプト内 `@/absolute/path.png` メンションで画像を読ませられる
  （8x8 赤 PNG で「Red」と正答）。ACP `initialize` の
  `promptCapabilities.image: true` とも一致。
- `--input-format stream-json` + `--output-format stream-json` で NDJSON 対話型
  print mode あり（複数ターンのバッチ実行向け）。

## ReadOnly 検証（実測）

作業ディレクトリ `/tmp/agy-ro-test` で実施。

| 条件 | write_file | command | 結果 |
| --- | --- | --- | --- |
| `agy -p`（既定） | auto-deny（`denied_actions` に記録） | **実行された**（`touch d.txt` 成功） | command は既定で許可 |
| `agy -p --sandbox` | auto-deny | **実行された**（`touch e.txt` 成功） | sandbox は terminal 制限であり write 禁止ではない |
| `agy -p --settings <deny payload>` | deny rule で拒否 | deny rule で拒否 | `f.txt`/`g.txt` 未作成、read_file は正常 |
| `agy -p --mode plan` | 計画提示のみ | — | ファイル未作成だが plan は保証ではない |
| `toolPermission: "strict"` + allow read_file | read_file も prompt 化 | — | headless では read も auto-deny。**不採用** |

- deny payload（`~/.config/agy/review.settings.json` と同一）:
  `write_file(*)`, `command(*)`, `read_url(*)`, `execute_url(*)`, `mcp(*)`,
  `unsandboxed(*)` を deny。read_file は workspace 内で既定許可のまま。
- deny rule による拒否は tool error として response 本文に現れ、
  `denied_actions` は空だった。検証側は `denied_actions`・permission error
  本文・workspace 差分の複数シグナルを見る必要がある。
- `status: "SUCCESS"` は禁止操作の失敗を含んでいても返る。レビュー成否の
  判定に status のみを使ってはいけない。

## ACP (`agy acp`)

- stdio JSON-RPC。`initialize` に対し `protocolVersion: 1`、
  `agentInfo: Antigravity ACP Server 1.5.14`、capabilities
  （`loadSession`、`promptCapabilities.image=true`、session resume/close/
  load/list、`additionalDirectories`）を返す。
- フラグ: `--app-data-dir`、`--gemini-dir`、`--cli_dir_name`、`--sandbox`、
  `--process-per-session`、`--login`（ACP terminal auth）。
- 別 `app-data-dir` / `gemini-dir` を指定すればプロファイル隔離は技術的に可能
  だが、認証情報もその配下に分離されるため別途ログインが必要。今回は未採用。

## クォータ / 使用量

- `agy -p "/quota"` が `command.name=usage` の構造化データを返す:
  モデルグループ別（Gemini Models / Claude and GPT models / 個別モデル）に
  weekly と 5-hour window の `remaining_fraction`・`reset_time`・説明文。
  `num_turns: 0` で LLM 呼び出しなしに取得可能。
- 内部 RPC に `GetUserQuotaSummary` / `RetrieveUserQuota` /
  `fetchQuotaStatus` が存在（文字列確認のみ、直接呼び出しは未検証）。
- サブスクリプション quota であり API 従量課金ではない。スケジューラは
  `remaining_fraction` と `reset_time` を見て投入量を決められる。

## 設定ファイル配置

- `~/.gemini/antigravity-cli/settings.json`: `trustedWorkspaces`
  （マシン固有）等。セッション限定上書きは `--settings`（JSON 文字列または
  ファイルパス、保存されない）。
- permissions の action: `read_file`, `write_file`, `command`, `read_url`,
  `execute_url`, `mcp`, `unsandboxed`。`action(target)` 記法、
  deny > ask > allow の優先順。`write_file` allow は `read_file` を内包、
  `read_file` deny は `write_file` も阻害。
- `toolPermission` 値: `request-review`（既定）/ `proceed-in-sandbox` /
  `always-proceed` / `strict`。

## 未検証・後続

- Windows / Linux での agy 動作（pc-setup lock 上は asset 解決済み）。
- `--json-schema` の実スキーマ強制、stream-json の複数ターン挙動。
- ACP 経由の session/prompt 実装詳細（harness 側 Issue #219）。
- keyring 認証が SSH 越しのヘッドレス実行で常に使えるか（本機では成功）。
- `JETSKI_APP_DATA_DIR` 等の環境変数による app-data-dir 上書きの有無と
  安全性。

## ハーネス統合での追加実測 (#219, agy 1.5.14)

- `--print-timeout` は裸の数値を拒否し `time: missing unit in duration` で
  exit 2。`"235s"` のような duration 文字列が必須。
- `agy -p "/quota" --output-format json` の `response` は JSON ではなく TSV:
  `<group>\t<label>\t<remaining %>\t<reset ISO>`（例:
  `Gemini Models\tWeekly Limit Remaining\t99%\t2026-11-29T17:03:28Z`）。
  `agent review` の quota probe はこの形式を正規化して buckets 化する。
- Seatbelt (`sandbox-exec` deny file-write* + allowlist) 配下でも keyring
  認証・モデル呼び出し・`--settings` deny は正常動作することを実機確認
  （`agent review run` で review-completed / protectedCheck clean）。
- `agent review run --executor herdr` は herdr workspace + `pane run` で
  `agent review run-file` を起動し、同一結果契約を返すことを実機確認。
