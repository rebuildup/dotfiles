# Windows miseの自動削除と復旧（2026-10-27）

WSL検査コードの全体テストでGit Bashから`mise`のshimを呼び出したところ、既存の削除予約が処理され、9つの旧バージョンが削除された。テストを中断し、Windowsの既存ツール復旧を優先した。認証情報やcacheを削除した証拠はない。旧バージョンの削除前hashは揃っていないため、再取得したファイルが削除前のカスタマイズを含めて完全に同一とは主張しない。

| ツール | 削除されたversion | 状態 |
| --- | --- | --- |
| gh | 2.103.0 | 元pathへ復元、全file hashを再取得元と照合、`--version` exit0 |
| Infisical CLI | 0.44.4 | 同上 |
| Claude Code | 2.1.306 | 同上 |
| Codex | 0.163.0 | 同上 |
| Supabase CLI | 2.121.0 | 同上 |
| Bun | 1.4.3 | 元pathの`--version` exit0 |
| open-code-review | 1.13.2 | 元pathの`--version` exit0 |
| Vercel CLI | 65.0.0 | 元pathへ再取得元から復元。Windows対話sessionで`--version` exit0。MacからのSSH sessionではjunctionの読取に失敗し、原因調査中 |
| OpenCode | 2.1.2 | 再取得はaubeの低download数検査で拒否。現行2.1.4は残存し、復旧方法を調査中 |

削除された7件を単純に「復元済み」と判断せず、MacからWindowsの元pathにある実行ファイルを直接起動してversion / exit0を確認した。最初の5件は全fileの個数とSHA256を別backendの再取得先と照合した。Vercelは通常file 7,231件のhashを照合し、junction 747件を元path内へ張り直した。元tree内にあったhardlinkの物理共有は復元していない。

Windows担当の対話sessionでは、復元されたVercelのentrypointをNode実体から起動して65.0.0 / exit0を確認した。一方、Macからの専用SSH sessionでは、元pathと再取得元の両方でjunctionを経由した読取が「信頼されていないマウントポイント」となり、Node起動もexit1だった。対話sessionとSSH sessionの差を記録し、削除前からの状態か復元時に生じた差かは未確定とする。Windowsのglobalなjunction policyは変更していない。

Windows上のmiseは`2026.9.11`。この版では`MISE_UPGRADE_AUTO_PRUNE=false`は新たな削除予約を抑えるが、既存の予約処理は抑えない。現行文書にある`MISE_PRUNE_EXCLUDE`もこの版には存在しない。起動時には別のmigration / cache処理もあり得るため、通常のmise/shimをこの復旧作業で再起動しない。[対象版の予約処理](https://github.com/jdx/mise/blob/v2026.9.11/src/tool_purgatory.rs)と[起動処理](https://github.com/jdx/mise/blob/v2026.9.11/src/cli/mod.rs)を確認した。

既定stateの予約ファイルを読み取った時点で残っていたのは`cargo-cargo-clean-all` 0.6.5の1件だった。この予約やユーザーのglobal設定は変更していない。予約処理を避けるには、利用中のmise versionと実行環境を確認したうえで安全な分離が必要である。通常の利用をすべて停止できたとは確認していない。

WSL検査コードの適用・gateway公開は、この復旧を優先するため保留している。復旧後も、元のtoolchainと独立した絶対pathを使うテスト方法を検証する。
