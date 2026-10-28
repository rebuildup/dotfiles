# Herdr Mac・WSL・Windows再検証（2026-10-29 JST）

## 経緯と証拠の扱い

ユーザーから「Macから他の端末のherdrに繋がったことは一度もありません」と指摘を受けた。2026-10-26/27記録のMac発Herdr成功主張を撤回し、当時のJSON・hashは履歴保全だけに残す。以下は独立した新規named workspace/paneを使って当日再実行した結果であり、旧ログに依存しない。

Macの専用clientは`~/.local/state/dotfiles/herdr-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/herdr-poc`。Herdr 0.9.5、protocol 22。既存default/focused workspaceは操作せず、全workspaceは`--no-focus`で作成した。確認は公式machine API / pane API経由。Windows paneは管理者PowerShellであり、安全上Codex agentを起動していない。

## Mac → Windows

Windows machine profile `e310d40031e946d9896f29d9f600d317`（`devnode-win-uuu-recreated`）で`machine status`がreachable、remote `workspace list`と`agent list`が成功した。新規workspace `mac-herdr-e2e-20261029`（remote workspace `w6`、pane `w6:p1`）をWindows上の既存監査用作業ディレクトリ配下に`--no-focus`で作成。Mac clientからpane commandを実行し、pane readで次のnonceと同一の出力を確認した。

```text
HERDR_E2E_WINDOWS_54ad0be8d8e3be3468e99d744d60f6a6
```

この結果はMacのHerdr clientからWindows Herdr serverへの遠隔pane操作を示す。Windows上のagent起動・assistant応答、Windowsの低権限worker適合性は示さない。Windows shellではmise trusted mount point errorが出たが、pane操作とnonce echoは成功した。

## Mac → WSL

WSL machine profile `4729223c1554f417f43e826826adb9e3`（`devnode-wsl-worker-1`）でreachable、remote workspace / agent listを確認。新規workspace `mac-herdr-e2e-20261029`（workspace `w4`）を作成し、pane `w4:p2`上で実行した。paneでは`PATH`に`/home/worker/.local/bin`を明示し、実ユーザー`worker`としてCodex 0.165.0を`--no-daemon`で起動した。`agent wait`でdone、`agent read`でassistant応答とnonceの完全一致を確認した。

```text
HERDR_MAC_TO_WSL_AGENT_df1c91f89debe48eb8105a0efd248d33
```

初回paneではPATH不足、二度目のagent起動ではCodex package不足により失敗した。環境を修正した専用paneで再実行し、完了した。失敗分は成功として数えていない。失敗agentが残るpaneは閉じ、成功paneは確認用に保持した。

## WSL → Mac

Mac Herdr serverに対し、WSL Herdrの実際のpane `w5:p1`で`HERDR_ENV=1`を確認した。そこからWSL内の公式Herdr clientで保存済みMac machine `6cf9da3f6f501e1c7952de8feb2e4825`（label `Mac controller`、target `poc-mac`、named session `devnode-poc-wsl-mac-2a1084ec`）のstatus reachableとremote workspace listを確認した。

WSL paneからMacに新workspace `wsl-to-mac-herdr-20261029`（Mac workspace `w3`、pane `w3:p1`）を`--no-focus`で作成し、そのMac paneでnonceコマンドを実行。WSL paneから同じMac paneをreadし、出力完全一致を確認した。

```text
HERDR_E2E_WSL_TO_MAC_06757283b8e52cfd9e1651b710b605b3
```

これはWSL Herdr clientからMac Herdr serverへのremote API/pane操作を示す。WSL内CodexがMac側でagentとして動作することはこの逆方向試験では確認していない。

## 結論と未検証

2026-10-29時点で、Mac→WindowsとMac→WSLのHerdr remote pane操作、Mac→WSLのCodex assistant応答、WSL→Macのremote pane操作を新規実測した。したがってユーザーの「これまで一度も繋がったことがない」という指摘は、少なくとも過去の記録に対する訂正として反映し、今回は独立再試験で接続が成立したことを区別して記録する。

未検証: Windows agentを非管理者workerとして起動すること、Windows→WSL、Headscale peer間、異ネットワークの研究室PC、Infisical MIの発行・最小権限、失効後の既存session停止、登録tokenの再利用拒否、制御面停止時の認証挙動、WSL再生成とjoin/leave。Tailscale/Headscale脆弱性対応も別途未完了であり、このHerdr試験はセキュリティ更新の根拠にならない。

試験で作成したHerdr workspace/paneは既存のfocused/default sessionに触れない専用検証資源として残した。削除や資格情報撤去の完了を主張しない。
