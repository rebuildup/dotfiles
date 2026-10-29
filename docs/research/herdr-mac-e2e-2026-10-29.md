# Herdr Mac・WSL・Windows再検証（2026-10-29 JST）

## 経緯と証拠の扱い

非秘密の構造化観測は[poc JSON](poc/herdr-mac-e2e-2026-10-29.json)に保存した。会話ID、raw terminal transcript、credential、private key、cacheは含めない。

ユーザーから「Macから他の端末のherdrに繋がったことは一度もありません」と指摘を受けた。2026-10-26/27記録のMac発Herdr成功主張を撤回し、当時のJSON・hashは履歴保全だけに残す。以下は独立した新規named workspace/paneを使って当日再実行した結果であり、旧ログに依存しない。

Macの専用clientは`~/.local/state/dotfiles/herdr-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/herdr-poc`。Herdr 0.9.5、protocol 22。既存default/focused workspaceは操作せず、全workspaceは`--no-focus`で作成した。確認は公式machine API / pane API経由。Windows paneは管理者PowerShellであり、安全上Codex agentを起動していない。

## 2026-10-29 後続の実状態確認（運用上の訂正）

上記の個別API/pane操作は、その時点の一回の遠隔操作が応答した証拠に限る。安定した接続、Herdr UIでのonline表示、各端末からの常時相互接続を示すものではない。ユーザーが実際の画面を確認した結果、MacではWindowsとWSLが`Reconnecting`、WindowsではMacだけが接続状態でWSLはなく、WSLではlocalしか表示されていなかった。この実運用結果を優先し、相互接続成立とは扱わない。

その後の読み取り検査では、Macの専用CLIからWindowsとWSLの各machine `status`は`reachable`を返し、remote `status server`もWindows 0.9.3 / WSL 0.9.5として応答した。ただしこれは都度SSH/API probeの結果で、UIの再接続状態を解消した証拠ではない。MacのTailscale peer一覧でUUUはonline、WSLはpeerとして存在しなかった。

WindowsのHerdr clientは0.9.3、Windows local serverは0.9.5 running・互換あり・binary stale・session null。Windows catalogはUbuntu/Ubuntu2/Macの3件だが、Ubuntu/Ubuntu2のSSHは`Connection refused`、MacはHerdr server not readyだった。実際のWindows WSL登録一覧はUbuntuだけで、Ubuntu2は古いHerdr登録と判断した。WSLの`basic`ユーザー環境ではHerdr実行ファイルが通常PATHと標準配置先から見つからず、WSLのmachine catalog/serverを確認できなかった。画面上での状態変更、profile操作、server restart、workspace作成は行っていない。

従って以前のpane nonce応答は遠隔API操作の履歴として保持するが、「Mac・Windows・WSLがonlineで相互運用可能」という結論は撤回する。現状の正しい判定は、**ユーザーUI上で接続不成立、再接続中。Herdrの常用接続とWSL登録は未達**である。

## Mac SSH経路修復後のHerdr操作

通常のHerdr UIが使うOpenSSH経路と、前回の専用CLIの経路が異なる可能性を調べた。`~/.ssh/config`には`devnode-win-uuu-recreated`と`devnode-wsl-worker-1`のhost stanzaがなく、Herdr machine catalogが参照する両targetを解決できなかった。既存ファイルを0600でバックアップし、node固有ssh_config 2件をIncludeした。`ssh -G`でWindows `basic@100.118.123.62:22222`とWSL `worker@100.118.123.62:22224`に解決し、標準sshからhost pin/public-keyを通じて両方へ接続した。

修復後、通常のMac Herdr CLIで明示profile IDを指定し、それぞれ別の`--no-focus` workspace/paneを作成してcommand出力を読み戻した。

| 方向 | 実機応答 | 制約 |
|---|---|---|
| Mac → WSL | `HERDR_LIVE_MAC_TO_WSL_20261029_1793237796` 完全一致 | WSL `worker`、Herdr 0.9.5。WSL server sessionは`devnode-poc-wsl-2a1084ec`で稼働。 |
| Mac → Windows | `HERDR_LIVE_MAC_TO_WINDOWS_20261029_1793237848` 完全一致 | paneの`UUU\\basic`はHigh Mandatory Level / Administrators enabled。nonceだけ実行し、agentは起動していない。低権限worker要件は未達。 |
| WSL → Mac | `HERDR_LIVE_WSL_TO_MAC_20261029_A73D58F9` 完全一致 | WSL `worker`のHerdr 0.9.5からMac profileへの専用remote session API経由。 |

これは明示Herdr machine API経由の3方向操作が今回応答した証拠である。Herdr UIのオンライン表示が`Reconnecting`から変わったかは再観察できていないため、UI上の常時接続・再接続完了は依然として未確認。Windows→Mac/WSLおよびWSL→Windowsは未達。Windows側はWSL profilesが`127.0.0.1:2222/2223`を指す一方、SSH listenersがTailscale IPv4 `100.118.123.62`にbindしている。WindowsのMac profileは終了済みremote session `devnode-poc-mac-20261026`を参照し、Macの稼働session名と一致しない。Windows向け修正と逆方向確認は未完了。

Mac catalogのWSL表示名を共有desired state `WSL · worker 1`へ追加し、既存private bindingでprofile ID/target/session一致を確認した後、公式`machine rename`でMac側だけ更新した。表示名はnon-secret configから再適用可能。Herdr profile追加/削除、Windows/WSLの設定変更は行っていない。

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

当日の試験では一回のMac→Windows / Mac→WSL / WSL→Mac remote pane API操作とMac→WSL agent応答が返った。一方、後続のユーザーUI確認では常時接続が成立しておらず、各端末の実際のオンライン相互接続要件は満たしていない。nonce応答をHerdrの安定接続成功とみなさない。

未達/未検証: Herdr UI上のonline維持と再接続復旧、WindowsからMacおよびWSLへの常用接続、WSL→Windows、Windows Herdrの非管理者worker化、Headscale peer間、異ネットワークの研究室PC、Infisical MIの発行・最小権限、失効後の既存session停止、登録tokenの再利用拒否、制御面停止時の認証挙動、WSL再生成とjoin/leave。Tailscale/Headscale脆弱性対応も別途未完了であり、このHerdr試験はセキュリティ更新の根拠にならない。

試験で作成したHerdr workspace/paneは既存のfocused/default sessionに触れない専用検証資源として残した。削除や資格情報撤去の完了を主張しない。
