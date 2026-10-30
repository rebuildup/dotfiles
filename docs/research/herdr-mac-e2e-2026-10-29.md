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

## Windows発接続の再確認

- 2026-10-29にWindowsの公式Tailscale CLIからv1.104.4へ更新。更新前後でBackendState=Running、IPv4=100.118.123.62、Self ID/User ID/tailnet identity一致を確認。Mac peerは更新試験中にofflineだったため、更新後peer疎通は未検証。
- Windowsから`100.118.123.62:22224`のWSL SSH host keyを照合し、Macの既存pinと一致。Windowsの既存`id_ed25519_herdr`で`StrictHostKeyChecking=yes`を有効にしても`Permission denied (publickey)`。Windowsの公開鍵fingerprintは`SHA256:DIyjoh8RN6/N1+ZcT5OLuev5tPLUkvaPC55ZyCPa1oI`。鍵登録・WSL変更は行わなかった。
- WSL変更前のread-only preflightでは、Windows `UUU\\basic`のWSL registryにUbuntu（default、WSL2、Running）だけがあり、専用devnode distroを識別できなかったためUbuntuには入らず停止。Windows `basic`のHerdr clientはMedium integrity。別Windows SIDが所有するworker distroをWindows controllerから操作する準備は未完了。
- WindowsからMacの専用SSH endpointも、Mac Tailscale peer offline中にtimeout。Herdrの一時profile追加は未実施。既存profileに変更なし。
- Macでは`brew-cask:tailscale`をmise package設定へ追加した。1.104.4公式pkgはmise applyが取得したが、`sudo installer`の認証待ちをキャンセルしたため更新は未完了。その後Tailscale.appを起動し直し、2026-10-29の後続確認では1.104.2 / `BackendState=Running` / IPv4 `100.83.203.34`、UUU peer onlineを確認した。したがってMacのネットワーク接続は復帰したが、Macの脆弱性修正版適用は未完了。

従ってこの時点ではHerdr UI上の`Reconnecting`解消は未確認で、Windows発のHerdr操作も成功扱いにしない。Mac側UIをコンピューター操作ツールから再観察しようとしたが、Ghosttyアプリはそのツールの安全制約でアクセス拒否された。ユーザー画面を見たとは主張しない。

## Macのネットワーク復帰後の確認

2026-10-29の後続read-only確認では、Mac Tailscaleは`BackendState=Running`、UUU peer online。Macから`devnode-win-uuu-recreated`（`basic@100.118.123.62:22222`）と`devnode-wsl-worker-1`（`worker@100.118.123.62:22224`）へのBatchMode SSHがそれぞれ終了コード0。WindowsからMacの専用Host `devnode-mac-herdr-live`へのpinned-key BatchMode SSHも終了コード0だった。これはSSH transport/authの到達性であり、Herdr接続状態の証明ではない。

同じ確認でWSL内の`worker`としてHerdr server processが動作し、Windows上のSSH forwarding経由のWSL SSH endpointも応答した。一方WSLはTailscale peerとして独立登録されていない。Windows Herdr client/server processも存在するが、Windows側Codex実行環境では`HERDR_ENV`が未設定だったため、適用中のHerdr Skillに従いmachine profile変更やpane操作を停止した。環境変数を偽装していない。

従って現時点で確認できたのはMac・Windows・WSL間の専用SSH到達性とWindowsのTailscale online状態まで。Herdr UIのonline/reconnecting表示、WindowsからMac/WSLへのHerdr操作、WSLからWindowsへのHerdr操作、Mac Tailscale 1.104.4適用はいずれも未確認または未完了である。

## 同一画面要件と実セッションの照合

ユーザーの要件はHerdr profile/configの同期ではなく、複数端末で同じterminal screenとpaneを同時に開き、一方の操作が他方にも反映されること。Herdrのmachine profile追加や名前同期だけではこの要件を満たさない。各端末が別々のdefault server/sessionを起動している限り、画面は独立する。

プロセスとsessionのread-only照合では、Windows UIのHerdrはWindows default server/session、Macの通常起動HerdrはMac default server/sessionを使っていた。従来のMac profileはWindows UIのdefaultではないnamed session `devnode-poc-win-20261026`を指していたため、MacとWindowsの画面が異なる直接原因になっていた。WSLの`basic` defaultと低権限`worker`のnamed session `devnode-poc-wsl-2a1084ec`も別々のserver/sessionである。

その後、Macから`herdr --remote devnode-win-uuu-recreated`（session指定なし＝Windows default）をmise管理のHerdrで起動し、Windows server上の既存内容がMac側terminal panelに表示されることを確認した。入力は送信していない。これはMac clientがWindows default sessionへremote attachした実証であり、Macの通常default画面をWindowsへ同期したものではない。Windows画面とMacのこのremote panelが同一sessionを表示することはHerdr remote接続の仕様に沿うが、同時操作による相互反映はこの確認ではまだ実演していない。

低権限workerのnamed sessionをMacとWindows両方から共有する経路は未完了。Mac→worker SSHは成功しているが、Windows専用鍵はworkerのroot管理authorized_keysで拒否された。Windows側鍵を管理者Windows SSH endpointへ追加して回避するとworkerに管理者shellを与えるため採用しない。Windows clientの公開鍵をworkerへ安全に登録するには、専用WSL distroの所有Windowsアカウントと公式managed provisioning経路の確認が必要。現状の`UUU\\basic`では専用distroがWSL registryに見えず、既存Ubuntu/defaultへ変更を加えていない。

その後のWindows専用管理SSHからのread-only照合で、worker所有アカウントは`pcw-2a1084ec5389`、SID `S-1-5-21-3608086955-217808620-105719149-1013`と確認できた。アカウントprofileはLoadedで、SID別`HKEY_USERS`のWSL registryに`pcw-2a1084ec-5389-4b0b-a0f0-9a38fcfaece5`（WSL2、BasePathはworker専用ProgramData領域）が登録されていた。basicユーザーのHKCUに見えなかっただけで、distro自体が消失・未登録という意味ではない。Windows worker SID所有の`wsl.exe` / `wslhost.exe` processも存在した。既存Ubuntuへ接続せず、guest・authorized_keys・distroを変更していない。公開鍵の正式なmanaged update経路はpc-setup側で確認中。

同じMac実機でHerdr client processの子にWindows（`devnode-win-uuu-recreated`）とWSL worker（`devnode-wsl-worker-1`）へのSSH bridge processが同時に存在し、今回の再確認中も生存していた。これは両remote transportの現在接続を示すが、pane操作の成功、UI上のonline状態、両clientが同じscreen/sessionを表示していることは証明しない。

2026-10-29の続く実機試験では、miseのHerdr 0.9.5から既存のMac-local profile IDを明示し、各専用`communication-proof` workspaceのidle paneへfresh nonce commandを送り、実行結果を読み戻した。Mac→WSLは`w6:p1`で`HERDR_LIVE_MAC_TO_WSL_AF1F898FBCE14C39B1827740EEAA05A4`の完全一致。Mac→Windowsは`w7:p1`で、PowerShellの入力echoと区別した`RESULT:HERDR_LIVE_MAC_TO_WINDOWS_0F3B1D5BE8884057A303579E284B5B96`の完全一致。Windows paneの実行identityは`UUU\\basic`、High Mandatory Level / Administrators enabled。両paneは専用remote server上の非focused test workspaceで、既存default/focused workspaceは変更していない。

これでMacからWindowsとWSLのHerdr paneを実際に操作できることは、この時点の新しいcommand/result往復で確認できた。一方、Windows/WSLからの逆方向操作、Windows clientのworker鍵登録、各端末UIでの同一screen確認はまだ未達。`pane wait-output`は入力echoにも一致しうるため、Windows試験ではcommand echoに完全nonceが現れない別形式の出力行を照合している。

Macではさらにmise管理のHerdr 0.9.5を`herdr --remote devnode-wsl-worker-1 --session devnode-poc-wsl-2a1084ec`でTTY起動し、Codex terminal panelへ表示した。SSH remote attachが接続してTUIを描画し、現在も実行中のterminal sessionとして保持されている。これはMac画面にWSL workerの指定named sessionを開く操作で、Mac default serverではない。WSL local clientが同じnamed sessionにattachしていることと、Windows clientがこのshared sessionへattachすることは、まだ別途確認が必要。

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

## 同一画面要件の訂正確認（2026-10-29）

ユーザーが求めるのはHerdr設定/profileの同期ではなく、Windows・WSL・Macの各クライアントが同じHerdr server/sessionの同じterminal paneを開き、同じ表示と入力結果を共有すること。画面共有の判定は、全クライアントの接続先server/sessionが一致し、同じpaneでの操作結果が各画面に現れることとする。

Windows側の読み取り専用確認では、現在のWindows TUIは`mac: work`を表示し、profile `Mac · macOS`、target `devnode-poc-mac-20261026`、remote session `devnode-poc-mac-14f29b3f-cda`を選択中だった。Windows local Herdr serverは別途存在する。稼働中のUbuntuではHerdr serverが動いていたが、現在のクライアントはなく、ログ上の最後の切断は2026-10-29 01:51 UTCだった。過去のshell historyにある裸の`herdr`コマンドだけでは、以前のWindows↔WSL同一画面のserver/sessionを特定できなかった。

Mac側には`herdr --remote devnode-wsl-worker-1 --session devnode-poc-wsl-2a1084ec`のremote TUI processがあり、Mac clientはWSL worker sessionを表示している。一方、上記Windows TUIはMac sessionを表示する。したがって両クライアントが現時点で同一画面を見ているとは言えず、同じpaneを同時に操作・観察するE2Eは未達。Remote APIでnonceを返した既存記録も、この同一画面要件の証拠とは扱わない。

次の受入確認は一つのserver/session（当面は分離済みWSL worker named session）にWindowsとMac clientをattachし、同じpaneに一意なnonceを一方から入力、もう一方の実画面にも同じ出力が表示されることを確認すること。WSL自身のclientも同sessionへattachできる場合に三者同時表示を記録する。Windows worker鍵の安全な追加は公式pc-setup key-stageだけで行い、認証が成立するまではWindows attachを成功扱いしない。

Windows worker鍵の追加は、Remote OpenSSH上のPowerShellからInfisical user loginのCredential Managerを参照できず失敗した。Infisical CLIは`A specified logon session does not exist`で終了し、秘密値を返さなかった。key-stage operationは初期化前で、WSL側authorized_keysは未変更。x64 PowerShell 7.6.9の対話的・昇格済みWindows logon sessionで同じ公式処理を実行する必要がある。実行用PS1はWindows `setup-audit`へoperationごとにCreateNewで配置し、ローカル/Windows間SHA256一致を確認している。秘密値はPS1に含めず、処理時にInfisicalからSecureStringへ直接取得する。

## 2026-10-29 続行時の接続先再照合

同一画面の要件に立ち返り、Herdr CLIの操作はせず、各クライアントのprocess・SSH設定・Tailscale状態を読み取り専用で確認した。MacではHerdr 0.9.5の`herdr --remote devnode-wsl-worker-1 --session devnode-poc-wsl-2a1084ec`が稼働中。WindowsのHerdr UIはWindows Terminal上でタイトル`mac: work`、選択profile `Mac · macOS`、target `devnode-poc-mac-20261026`、remote session `devnode-poc-mac-14f29b3f-cda`。Windows Tailscaleは`100.118.123.62`でRunning、Mac peerはonline。したがってMacの表示中sessionとWindows UIの表示中sessionは現在も異なる。

同じWindows上のUbuntu WSLではuser `basic`のHerdr processとlocal session `w1`が存在するが、現在のshellで`HERDR_ENV`は未設定、`~/.ssh`とSSH config、ssh-agentも存在しなかった。Mac Tailscale IPへのrouteはWindows gateway経由で存在するが、WSLからMac SSHへのTCP/認証は未検証。このWSLからMacへ同じsessionを開くSSH identityは現時点で存在しない。Windows PowerShellとMac側のこのCodex実行環境も`HERDR_ENV`未設定だったため、適用中のHerdr Skillの条件に従い、Herdr CLIによるsession/pane操作は行っていない。

これにより、現状の画面不一致だけでなく、WSL `basic`からMac sessionへremote attachする際の欠落（SSH identity/config）も確認した。実画面共有E2Eと同一paneの相互入力確認は依然として未達であり、上記状態から成功を推定しない。

なお、Windowsから起動した`wsl.exe`が示すUbuntu `basic`と、独立登録済みのWSL worker（SSH user `worker`）は同一環境ではない。Macからworker SSH endpoint経由でread-only確認したところ、workerには`poc-mac`というMac用SSH設定があり、接続先`rebui@100.83.203.34:22223`、専用identity、`StrictHostKeyChecking yes`、専用known_hostsを使っている。workerから`ssh -o BatchMode=yes poc-mac true`はexit 0だった。よってworker→MacのSSH認証経路自体は存在する一方、現在のUbuntu `basic`には同等の経路がない。この結果だけではHerdr TUI attach・同一session表示・同一paneでの相互入力は証明しない。

## 2026-10-29 同じpaneの三者TUI相互入力実測

前節までの「TUI attach未達」は、その後の明示的な同一server/sessionへのattach確認で更新する。これはHerdr設定の同期ではなく、同じHerdr serverが保持する同一terminal paneを各TUIが実際に表示し、入力を共有する試験である。

- 対象server/session: Mac上の`devnode-poc-mac-14f29b3f-cda`。対象workspace/tab/pane: `work` / `w5:t1` / `w5:p1`。paneのcwdは`/Users/rebui/work`。
- Macはmise管理Herdr 0.9.5でnamed sessionへattach。WindowsのHerdr TUIとWSL workerのHerdr TUIは同じMac named sessionへ公式remote attachした。WSL側TUIの画面には同じpane上のWindows・Mac由来マーカーが表示された。
- Herdr CLIで`workspace focus w5`を適用後、read-onlyの`pane current`照合が`w5:p1`、focused=trueを返すことを確認した。これはserver session内のworkspace表示選択で、paneやagent processの再起動はしていない。
- WSL TUIから`echo WSLPROOF`を入力し、同じpaneに`WSLPROOF`が出ることを画面とpane履歴で確認した。その後WSLから`HERDR_SHARED_SCREEN_FROM_WSL_20261029_C5A49E12`を入力。Mac TUIのfresh attachとWindows TUIから同じ文字列を確認した。
- Windows TUIから`HERDR_SHARED_SCREEN_FROM_WINDOWS_20261029_B27E6D14A8C35791`を入力。Macの同一pane履歴とWSL TUIの画面に同じ出力が現れた。Windows側担当も、同じMac sessionの`work` paneにWSL入力が表示された後、Windowsからの入力・出力が一致したと報告した。
- 既存の`HERDR_SHARED_SCREEN_PROOF_20261029_A7C314D9`とWindows発の`HERDR_SHARED_SCREEN_FROM_WINDOWS_20261029_6E7B9F1A2C4D8E35`も同じpane内容として各TUIへ描画された。

この実測で、Mac・Windows・WSL workerが同じHerdr server/session/paneを使う三者間の画面共有と、WSL→Mac/Windows、Windows→Mac/WSLの入力反映を確認した。以前各端末で異なるdefault server/sessionを表示していた状態では同期されなかったため、各TUIから同じnamed sessionへattachして`work` workspaceを選ぶ必要がある。

限定事項: Mac TUIのmachine catalog側ではWindows/WSL profileが`connecting`と表示される場面があった。ここで実証したのは、三者がSSH経由で同一named Herdr server/sessionにattachした画面共有であり、catalog status表示の解消、Headscale transport、network policy/role分離、WSL再生成、Infisical MI、ノード失効やHerdr再接続復旧の実証ではない。`work` paneに試験用`printf`/`echo`履歴が残っている。既存設定やpane processは再起動していない。

## 2026-10-29 live attach 再確認

継続ターンで現在の接続もread-only確認した。MacのHerdr 0.9.5 named server `devnode-poc-mac-14f29b3f-cda`は稼働中で、`workspace list`では`work`（w5）がfocused、`pane current`は`w5:p1`を返した。pane readにはWSL発`HERDR_SHARED_SCREEN_FROM_WSL_20261029_C5A49E12`とWindows発`HERDR_SHARED_SCREEN_FROM_WINDOWS_20261029_B27E6D14A8C35791`の両方が残っている。

Mac側process listではWSL workerからのremote TUI用SSH attachが2接続生存。Windows側の読み取り確認では、Windows TUI `mac: work`とSSH childが生存し、Mac `100.83.203.34:22223`へのTCPが`Established`、接続先sessionも同じnamed sessionであることを確認した。Windows画面はWSL/Windows両マーカーを表示していた。再入力・session切替・service再起動はしていない。

以上でMac・Windows・WSL workerの各TUIが同じHerdr server/session/paneを共有し、三者方向の入力結果が同じpane画面へ伝播するPoCを実画面とprocess/socketで確認した。これは明示remote attachでの同一screen通信であり、machine catalogの`Reconnecting`表示やHeadscale transportの検証とは別である。
