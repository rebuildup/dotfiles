# Herdr独立共有hostのPoC（2026-10-29）

## 目的

Mac/Windows/WSLをHerdr serverとして固定せず、全端末が同じserver/session/paneに直接attachできる独立hostを用意する。Herdrの複数machine catalogは接続先ごとの独立server/sessionを表示する機能で、単一画面の同期ではない。表示中の画面を共有するには同一Herdr server/sessionへのremote attachが必要。

## 選択したPoC配置

- host: 既存Infisical/Headscale VPS `tastile-infisical` (`157.180.90.160`)
- Herdr: 公式Linux x86_64 v0.9.5。公式`latest.json`のSHA-256 `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`と取得binaryが一致することを確認。
- 実行user: `herdr-shared`。UID/GID 1000の専用user/group、SSH鍵認証のみの運用、Docker group・sudo権限なし。homeとauthorized_keysは本人のみアクセス可能。Docker socketへのアクセス試験とsudo権限試験はいずれも拒否。
- network: 追加listen portやfirewall変更なし。既存SSH TCP/22を利用。
- data: `/home/herdr-shared/work`と専用Herdr state。Infisical/HeadscaleのDocker設定・container・volumeは変更していない。
- credentials: Mac用の新規ed25519 private keyをMacの`~/.ssh/id_ed25519_herdr_shared_vps`に作成。公開鍵だけを専用userへ登録。既存の管理用鍵やWindows/WSLの秘密鍵は流用していない。
- local target: Macの`~/.ssh/config`に`herdr-shared-vps`を追加。Herdr 0.9.5のmise管理binaryで`herdr --remote herdr-shared-vps --session shared`を起動。

## 実測

- SSH host key検証を有効にしたMacからのpublic-key loginが成功し、接続userが`herdr-shared`であることを確認。
- 公式Herdr remote attachでVPS上にnamed session `shared`が作成され、workspace `~` / `w1`、tab `w1:t1`、pane `w1:p1`の単一構成になった。
- 試験nonce `HERDR_VPS_SHARED_20261029`を同一paneへ送り、同じpaneから読み戻せた。
- attach clientをdetachした後も、`herdr session list --json`が`shared`を`running: true`として返し、pane/sessionが残ることを確認。
- Macから同じtarget/sessionへ再attachできることを確認。

## 結論と未検証

このPoCはMacをHerdr server hostから外し、Macが停止してもVPS上のHerdr sessionが残ることを示す。VPSは単一障害点として残り、再起動後の自動起動・復旧はまだ構成していない。Infisicalと同じVMで任意shell/agent codeを動かすため、専用unprivileged userの分離だけではVM/kernel障害境界は分離されない。長期運用採用前に、同居リスクを許容するか、独立VMへ分けるかを決める必要がある。

現時点でSSH許可済みなのはMac用公開鍵だけ。WindowsとWSLの鍵を追加・接続していないため、他端末から同じ画面へ入れるE2Eは未検証。Windows/WSLの鍵を共有・コピーせず、各端末で固有鍵を作り、公開鍵だけを個別登録する。Herdr本体はMacのmise管理版を使う。

```sh
herdr --remote herdr-shared-vps --session shared
```

他端末では`herdr-shared-vps`に同じ表示名のSSH host entryと、その端末固有鍵・host pinが必要。その後`herdr --remote herdr-shared-vps --session shared`を実行する。Herdr clientは全端末で同じserver/sessionに向けること。通常のlocal `herdr`を開くと各端末の独立sessionになり、画面は同期しない。

VPS上にCodex/Claude等のagent runtimeや認証情報は導入していない。agent実行場所・ノード指定、Infisical Machine Identity、node lifecycle、Headscale transport、negative access testは未達であり、この画面共有PoCだけで分散開発基盤の完成とはしない。

## 継続検証

Windows/WSLをofflineと推定して作業を止めた判断を撤回。MacからWindows `basic` とWSL `worker`の専用SSHへ実際に到達した。WSL worker上でVPS用固有鍵を生成し、公開鍵のみVPSへ登録。専用host pin付きSSH認証と公式remote TUI attachが成功し、WSL TUI入力 `WSL_SHARED_LIVE_20261029` とMac TUI入力 `MAC_SHARED_LIVE_20261029` がVPSの同一paneに到達した。Windows専用公開鍵もWindows担当が生成しVPSへ登録済み、Windows TUI実測は進行中。

この共有sessionには非秘密の検証文字列だけを置く。低権限workerが共有sessionへ接続できることを、他nodeを制御する権限の付与と混同しない。

共通受入条件を `docs/herdr-acceptance.md` に固定。`script/test`、`script/test-workflow`、`script/check-secrets` は成功。`script/check` は実HOMEがprimary checkoutを参照していること、OS固有ファイル欠落、Claude composed settingsの差分を報告したため成功扱いにしていない。検査worktreeへ実HOMEを付け替える修正はしていない。

## 実作業sessionとの不一致の根本原因

追加調査でMacの実作業はdefaultのAulymo(w3Q)・xyt-media(w4B)、Windowsの実作業はdefaultのAe_Restro(wE)である一方、従来machine profileは別のPoC named sessionを指していたと判明した。VPSの空の共有sessionはこの不一致を解消しない。VPS共有はHerdrの共有能力確認として区別し、実用接続は各nodeの実作業sessionへ向ける。

MacのWindows profileを公式machine addでdefaultへ向け、Ae_Restro(wE/t1)がWindows直読と一致することを確認した後、旧PoC profile参照だけを公式remove、新profileをUUU · Windowsへrenameした。新profile IDは3202e4b584c237bb11db58dddc10d640。private machine bindingもdefaultへ更新。Windows server/workspace/processは停止していない。

VPS共有ではWindows TUI入力WINDOWS_SHARED_LIVE_20261029がMac/WSLにも描画され、Windows追加tab w1:t2/p2とWINDOWS_TAB2_20261029を確認。Mac direct client終了後もWINDOWS_WITHOUT_MAC_CLIENT_20261029が実行された。Mac再attachも成功。これは実作業nodeのsession照合と別の証拠である。

## 実作業sessionへ接続する設定

WSL workerのMac profileも旧PoC sessionからMac defaultへ変更。新profile b588309caf2d43f692d778147e6ac6ac（label Mac · macOS, target poc-mac, session default）でMac直読と同じAulymo(w3Q)・xyt-media(w4B)のworkspace一覧を確認。旧profile 6cf9da3f6f501e1c7952de8feb2e4825は接続参照のみ削除し、旧server/processは停止していない。

Windowsにはmac-default（profile e6ca621d2ba25e443df0a8c850e5fc84, target devnode-mac-herdr-live, session default）が存在する。Mac→Windows SSH経由でこのmachine APIを実行した結果はnoninteractive SSH command timed outだった。一方、同じWindowsからMacへOpenSSHを直接実行し、mise実体とmise shim両方のHerdr version、およびMac defaultの実workspace一覧取得は成功。したがってSSH認証障害やnode offlineという判定は誤りで、Herdr remote probe/API経路を継続調査している。Windows native TUIでの実表示と、nested SSH経由のAPIを別々に確認する。

## 19時台の継続検証

Windows担当の実機TUIでmac-defaultにMac defaultのAulymo(w3Q)・xyt-media(w4B)が表示された。Windows default Ae_Restro(wE)も維持した。同時刻のWindows client logはendpoint handshake成功、Mac server logもremote client接続を記録。nested SSHからのmachine APIのtimeoutとは異なる結果として扱う。

新たにWSL worker endpoint TCP22224がbanner timeoutとなった。Windows portproxyは100.118.123.62:22224→172.22.157.236:22224だが、Windowsから転送先TCPへのTest-NetConnectionはFalse。Mac→Windows専用SSHは成功。したがってMac側のHerdr profile名変更だけでは復旧せず、worker起動/転送先と監視をWindows側で調査中。過去のWSL成功を現在の到達性の証拠として使わない。

## セキュリティreviewによる訂正

独立reviewで、低権限WSL workerが所有するMac用SSH鍵は`restrict,from=...`だけでは任意command実行を制限しないと指摘された。worker agent userからMacのhuman default sessionを操作できる状態は最小権限と両立しない。Macの専用sshd authorized_keysから当該worker rotated公開鍵を撤回し、Windows human operator公開鍵だけを維持した。VPS shared userのauthorized_keysからもworker専用鍵を撤回、Mac/Windows operator鍵は保持した。worker→Mac/VPSの新規認証拒否試験はworker復旧後に行う。人間がWSLを操作端末にする要件は、agent実行workerと別のoperator user境界で実現する必要がある。

共有terminalの出力・topologyと、client固有の選択tab/focusは別に実測する。Herdrはclientごとに別tabを選べるため、同じserver/sessionだけでfocusの自動追従まで保証しない。実作業sessionの双方向入力試験には既存作業paneを使わず、所有を明示した検証tab一つを使い、終了後にそのtabだけを閉じる。

## 実default sessionへの入力往復

Mac defaultのAulymo(w3Q)に一つだけconnection-check tab w3Q:t4、pane w3Q:p7、cwd=/private/tmp、terminal_id=term_65ef7f60c7cb233をno-focusで作成。MAC_REAL_SESSION_20261029とWindows operator→Mac専用SSH経由のWINDOWS_TO_MAC_REAL_20261029が同じpaneで実行された。Windows defaultのAe_Restro(wE)にもconnection-check tab wE:t2、pane wE:p2、cwd=Windows user Temp、terminal_id=term_65ef7f7fb308c2をno-focusで作成。MacのHerdr machine APIでWrite-Output MAC_TO_WINDOWS_REAL_20261029を実行し同paneから一致出力を読戻し。既存作業paneは使用していない。検証tabはWindows側描画・再接続確認後に所有tabのみ閉じる予定。

VPSのworker専用認可撤回後、herdr-shared userのprocess一覧にssh remote bridge/clientは存在せず、共有serverと二つのshellだけが残ることを確認した。既存workerの生きたVPS SSH sessionが残る状態ではなかった。

## Git同期コマンドの実測

`devnode sync`を7694c93で追加。Macの正規GitHub sourceから作った一時cloneをfbbd807へ戻したtest fixtureで、7694c93へのfast-forward→更新checkout側machines apply（既存Windows/worker表示変更なし）→再実行noopを実測した。fixtureは検証後削除。既存Bunテスト29 pass / Windows ACL test1 skip、script/test、script/test-workflow、script/check-secretsは成功。

Windows operatorには`C:/Users/rebui/AppData/Local/dotfiles-node-runtime-74-20261029`のclean branch74 cloneと、`C:/Users/rebui/AppData/Local/dotfiles-devnode-operator-20261029/machines.json`のprivate bindingを作成。binding file/parentは本人・SYSTEM・Administratorsのみ、本人owner/protectedACL。mise導入済みBun1.4.2の実体でsync成功し、Mac profile e6ca621d2ba25e443df0a8c850e5fc84のlabelがmac-defaultからMac · macOSへ公式renameされた。target/sessionは維持。起動時自動同期は未構成。これはsourceと所有済み表示名の同期であり、worker登録・remote session自動切替・資格情報同期を行わない。

## 日常起動入口と修復の実行境界

source1288919の`devnode open`をMac operatorの専用runtime checkoutで実機確認。別named session環境HERDR_SESSION=devnode-sharedを与えても、sync後のchildは実際に`herdr --session default`で起動し、Macの実作業とWindows実Ae_Restroを表示した。clientはdetachでexit0、serverと作業processは継続した。実機確認用runtimeは`~/.local/share/dotfiles-node-runtime-74-20261029`。HOMEのprimary checkoutリンクは移していない。

Windows repair codeはpc-setup PR143の4e08a23f958c18ccf80cc119e650bbe2efc97bc1へ更新。instance lockとjournal resumeを含み、対象test/CI成功とのWindows報告を受領。Windows CIのmise global dataへの副作用は同じ版への復元とCIのdata/cache分離修正を行った。実機controller自動実行はツール承認reviewが理由詳細なしで拒否したため回避しない。controllerはclean source/commit/runtime SHAの事前検査付きで、人間の管理者PowerShell7実行待ち。controllerSHA256=8D33EC02C665D4104E1B23555F4C8C9BABE0CBE76EF900CDC1B76B7B6637D8F5、runtimeSHA256=1DBB76DBE660317C2BC197DEE81ADA34CE8D2FEA4358D921818C81A01953822A。結果はWindowsのsetup-audit/wsl-ssh-142-20261026/result-RepairController-v1.jsonをread-only回収する。実機復旧成功とはまだ扱わない。

## 人間による限定repair実行の結果

ユーザーが固定controllerを実行。result-RepairController-v1.jsonはStatus=failed、Phase=restart-worker-and-repair-owned-gateway、FailureType=RuntimeException。source SHA・SID・host pinは期待値と一致したが、CurrentAddress/HoldPIDはnull。SSH22224も未復旧。Windows側の管理者read-only事後診断ではrepair manifestのみ作成、journal空、worker process無し、旧mapping保持。失敗はhold intent保存・mapping変更より前のcredentialed V3検証呼出しに絞った。旧結果や証跡は上書きせず、次versionで非秘密の段階・exit code telemetryを追加する。

画面共有の最終仕様はユーザーの回答「同じtabを選べば内容が一致すればよい」。各clientが別tabを選べるHerdr公式動作を許容し、選択focusの自動同期や別の画面共有基盤は追加しない。

## 2026-10-30 再開時の再検証

- WindowsのV2結果をMacから専用SSHで回収。`FailureStep=read-only-v3-verification`、`Expected fresh credentialed guest verification.`。Windows側調査ではV3 reportにV1 validatorを適用した不具合であり、credential失敗とは扱わない。修正PR143 `a2f7813c2251a11a271f1bd2cb45784cc4db6976`。
- Windows上の`controller-repair-v3.ps1`をSHA256 `8B55FCFF98FF18DF3454BB1EB446145F349B45D31A38FF41E63CAC6472A08B6E`と照合。結果ファイルはまだ存在せず、人間へ管理者PowerShellで手動実行を依頼。前回の自動承認レビューによるsecret/admin controller実行拒否を回避しない。
- Macのmachine catalogはWindows実`default` profile `3202e4b584c237bb11db58dddc10d640`、WSL専用profile `4729223c1554f417f43e826826adb9e3`の2件。
- Macの専用runtime cloneの`mise run nodes`を実行。`1288919`から`9f12c79`へfast-forward、表示設定はnoop、実`default`とWindows Ae_Restro表示を確認してCtrl+B qでdetach、終了0。新規workspaceは作成していない。WSLはconnecting/reconnectingのまま。
- MacからWindowsの公式`workspace list`はAe_Restro `wE`、2tab/2pane、active試験tab `wE:t2`を返した。CLIに`--json`は未対応でusage失敗したため、そのflagを外して再確認した。
- `script/test`、`script/test-workflow`、`script/check-secrets`、`git diff --check`は成功。実`script/secrets-doctor`はself-hosted Infisicalのlogin、project access/runtime injectionまで成功。`script/check`はprimary checkoutを指す既存HOMEリンクとOS別missing、既存Claude設定差異で失敗し、worktreeへHOMEリンクを勝手に付け替えていない。
- 未完：WSL V3修復、fresh Mac鍵登録、WSL実Herdr・拒否試験、Windows native再接続証拠、OS再起動後の復旧、別WSL再生成。起動入口の単回成功を再利用可能な基盤の完成とは扱わない。

### V3実行後：SSH復旧とcommit失敗を分離

人間によるV3実行を確認。結果は`Status=failed`、`FailureStep=manifest-commit`、`File.Replace`の空path例外。runtime312行の`[IO.File]::Replace($pending,(Join-Path $root 'manifest.json'),$null)`が失敗箇所で、記録commit未完了。版を増やした即時再実行は依頼せず、Windowsの一時fixtureで原子保存処理とresume経路の再検証を依頼した。

同時点でMacから既存strict host pin付きSSHは終了0、`WSL_REPAIR_PROBE`が完全一致。`id`はworker uid1000/groupworkerのみ。Herdr0.9.5はあるが、対象named sessionはserver_not_runningであり、停止前のprocessが復元したとは主張しない。修復記録の確定前にworkerを再起動していない。

実際の失効検証：workerから既存`poc-mac`へBatchMode接続は`Permission denied (publickey)`終了255、workerから`herdr-shared-vps`も同じく公開鍵認証拒否終了255。以前撤回したworkerのoperator権限を復活させていない。SSH到達だけを修復・永続化・Herdrの完成と扱わない。

### WSLの実Herdrとagent起動を再検証

通常の公式`herdr --remote devnode-wsl-worker-1 --session devnode-poc-wsl-2a1084ec`で既存named serverを起動し、detach終了0。既存workspace `~` (`w1`)の試験用tab `connection-check` (`w1:t2`, `w1:p2`, terminal `term_65efcb5bfdb872`, `/tmp`, no-focus)を1つ作成。Macのmachine APIで`MAC_TO_WSL_REAL_20261030`を出し、同APIとWSL内のHerdr APIから同じpaneをreadして全文一致した。元tabは触っていない。

WSLの個別Codex login statusはChatGPT login。試験paneで`codex exec --skip-git-repo-check --sandbox read-only --ephemeral`を起動し、ファイル・ツールを使わない算術のみの指示に`DEVNODE_WSL_AGENT_OK 391`、`CODEX_TEST_EXIT=0`を取得。Mac/WSL両APIで同じ応答・終了表示を確認。agent session ID `01a18860-8567-75b3-b685-54e411c75048`。

品質上の残件：workerのCodex0.165.0は単体binaryのみで`codex-code-mode-host`が欠落、Code Modeはfail closed。bwrapはPATHになくbundled fallbackの警告。単純応答は成功したが開発tool実行の完成とはしない。公式release APIにはfull package `codex-package-x86_64-unknown-linux-musl.tar.gz` SHA256 `e97c4463d7f146692a955d7b0e1c8cf48f97cd4d616cd45c5dcab2e8d9743316`があり、pc-setup側の再現可能なruntime導入手順で対応する。個別loginはコピーしない。[公式release](https://github.com/openai/codex/releases/tag/rust-v0.165.0)。

Macの公式remote TUIを再接続し、Ctrl+B 2で試験tabを選択。実際のTUI描画に`connection-check`、`DEVNODE_WSL_AGENT_OK 391`、`CODEX_TEST_EXIT=0`を確認した。API読取だけでなくremote attachの描画も確認後、Ctrl+B qでdetach終了0。WSL user/hostはworker@UUU。2tabは同じserver/sessionの`w1:t1`と`w1:t2`で、clientの選択追従は要求しない。Windowsからの同tab表示は別途未検証。

現行`devnode machines status`もWindows/WSL両方を`reachable`と返した。WSL worker catalogに残る認可撤回済みMac profile `b588309caf2d43f692d778147e6ac6ac`は公式`machine disable`で無効化し、同ID/target/sessionのままenabled=falseを確認。Macのserver/session/paneを変更していない。workerにoperator権限を与えず、WSL人間operatorの実行経路は別の受入項目として残す。

### 回復性・runtime配置の追加検証

WSLへの未登録鍵拒否を、新規一時ed25519鍵・専用known_hosts・StrictHostKeyChecking=yes・IdentityAgent=none・IdentitiesOnly=yesで実施。公開鍵認証拒否/終了255、stdout空を確認。試験鍵は一時領域とともに撤去し、既存鍵を変更していない。

pc-setup PR143 `e0224923d98102925c0c976d0e98e3e72095a3f2`は、明示backup付き原子manifest置換と中途状態のresumeを追加。独立reviewで、receipt削除後の既存manifest.Hold再利用・no-op commit中断・backup残存からの回復を確認した。CIで実行bitとLinux PowerShell fixtureのWindows path依存を検出し、後続修正を検証中。実機への新controller実行はまだ行っていない。

Codex runtime調査では、pc-setupのUbuntu/WSL guideがportable CLIのmise一元管理を指定し、既存mise global lockもaquaのfull packageを使用していた。workerへの独自tar installer追加ではなく、限定mise bootstrapと旧単体配置の非破壊migrationを次工程とする。0.165.0から既存lock0.162.1へ暗黙downgradeしない。公式packageは`bin/codex`隣の`bin/codex-code-mode-host`、`codex-resources/bwrap`、`codex-path/rg`、`codex-package.json`を含み、配置を保ってresource discoveryを利用する。[公式package構造](https://github.com/openai/codex/blob/rust-v0.165.0/scripts/codex_package/README.md)・[既存aqua backend](https://github.com/aquaproj/aqua-registry/blob/main/pkgs/openai/codex/registry.yaml)。

最終fixture修正版 7f2241235b28ebd19439450554bfc3ebbbc0924c はGitHub CI run 40910971126 のnix/powershell/shell/windows-worker全jobが成功。CodeRabbitはReview skippedであり人的・独立コードレビューの代替に数えない。Macのmise管理PowerShell7.6.6でも独立tempcloneからscripts/test-windows-worker-ssh.ps1がPASS/終了0。productionのWindows exe取得helperはSystemDirectory空なら拒否し、従来のsystem wsl.exeだけを返すことを独立reviewで確認した。Linux用fallbackはfixtureのmockに限定。Windows固有の旧null-overload問題の再現試験はWindows jobで実行し、新backup方式とrepair全関数の中断/resume fixtureは全OSで実行する。実機controller成功・永続起動の証明とは分離する。

## V4実機確定と古い選択参照の撤去

人間がcontroller-repair-v4.ps1（SHA256 F6B2E64B6FB61EC80B7B23C2C030FA557D07130F6C9B5D162757419EA990C84C）を実行。result-RepairController-v4.jsonを専用SSHで回収しStatus pass / PendingConsumed trueを確認。SourceCommit7f224123、runtime77C209A4BE06B8F0275292556852BDA6BDF9C5D0E9D62D0F0DED1769024A6004、HoldPID21964、guest172.22.157.236、hostpinFoPM…を維持。manifest SHA256 B1567AED8AEBAD1335C5F9EF1811F27B9A4B635D04DA98519F88946B9562DD0F。標準sshdはStopped/Manual。MacからSSH nonceと既存worker Herdr w1/t1,t2も再確認。これはrepair記録確定の成功で、常設起動やreboot成功ではない。

Windows catalogには今回所有する旧mac-poc profile c0f6ac3950c614ced3b168c9e5952183（target devnode-poc-mac-20261026/session devnode-poc-mac-14f29b3f-cda）がselected=trueで残っていた。実Mac default profile e6ca621d2ba25e443df0a8c850e5fc84と別なので、旧PoC profileだけ公式machine removeで撤去。server/session/paneの削除は行っていない。既存Ubuntu/Ubuntu2の参照は対象外。

worker runtimeの再現可能なmise導入はpc-setup Issue146として別branch146/worktree /Users/rebui/.local/share/devnode-source/worktrees/worker-runtimeで着手。App native worktreeはsourceRootがchat workspace外のため利用できず、Operating Modelのnative Git fallbackで分離。Windowsのcontroller用checkoutへは書き込まない。まだruntime実装・実機適用は未完了。

## 2026-10-30 worker runtime実機適用とsudo境界

ユーザーが専用workerでpc-setupを実行しsudoで停止したため調査。idはworker uid1000/groupworkerのみ、passwd -SはL(locked)、Ubuntu24.04/Python3.12.3。Linuxで使えるsudo passwordは設定されておらず、InfisicalのWindows起動用資格情報とは別。管理側OS maintenanceを用意し、workerへ恒久sudoを暗黙付与しない。

公式mise.run installerのchecksum検証経路でmise2026.10.22をworkerの.local/binへ導入した。shell設定は変更せず、認証cacheも移送していない。PR147の8fe5beb snapshotから3fileだけをprivate source bundleへ転送・hash照合してinstall。vendor Herdrがworker-owned/mode775でありstrict guardに停止、current未公開・旧binaryを維持。sourceで新candidate限定の安全なpermission正規化を追加し、外部symlink/hardlink/別UID/special bits拒否を含む20fixtureと全CIが成功した0f024dcc0a76a48706bca024a22ab94950740716を別bundleで適用した。Macの既存Python3はtomllibなしでfixture開始前に失敗したため、mise管理Python3.14.10で再実行し20件成功。worker実機は3.12.3で適合。

適用sourceのSHA256はworker-runtime.py=c1322ebf13d144f286e5f5d3f60fda2ed6ba2f3a9cc3663a8bcce5753a00ccc4、mise.global.toml=40a289d1d66adc384774f65502ec14246fbbcedc5c1032e607e9b6cdee201fe9、mise.global.lock=66e466b46476f0fa7ad1e1b684056aa8fa6278bca66b025a319d71e7ef49a085。install/verifyはCodex0.165.0、Herdr0.9.5を返し、再installも成功。

既存workspaceはユーザーによりworkへ変わり、旧試験pane w1:p2は存在しなかった。不存在errorで操作が実行されていないことを確認後、実listからw1を取得し、no-focusのverify tab w1:t3/pane w1:p3/terminal term_65f08279c81353を作成。専用workspace directoryは/home/worker/.local/state/pc-setup/worker-runtime-e2e/edit-test-ea2r1vwb。意図的に壊したmultiplyの3testが先に失敗することを確認し、Herdr paneから新Codexを起動。calc.pyだけを修正して3test成功、CODEX_EDIT_TEST_EXIT=0。rootもtestを再実行して成功。Codex session ID01a18b4d-d8b9-7121-b10c-621f7d0de880。code-mode-host欠落warningは解消した。bubblewrapはPATH未導入のためbundled fallback warningがあり、実tool実行は成功した。

sandboxはmodelの報告だけを証拠にせず、追加の実shell-tool probeで作業内file書込成功、作業外の専用probeへの書込がRead-only file system、OUTSIDE_WRITE_DENIED、SANDBOX_AGENT_EXIT=0を確認。rootから作業内probeあり・外probeなしも再確認。直接codex sandbox CLIの試行はdefault read-onlyで作業内も拒否したため、このworkspace-writeの証拠には数えない。

通常入口へのmigrationは旧binaryのSHA256（Codex c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5、Herdr14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d）を確認し、sourceの明示migrateでlegacy backupを保持して.local/bin symlinkへ切替。個別Codex loginは維持されている。Macから新Herdr入口へremote TUI再接続し、verifyを選択して実出力を描画・detach終了0を確認。tab keyboard indexは現在の並び順2であり、安定ID末尾3とは区別した。userのwork paneへコマンド入力していない。

### 2026-10-30 後続の疎通・ネットワーク確認

MacからWSL machine ID4729223c1554f417f43e826826adb9e3のstatusはreachable。tab一覧は既存w1:t1とverify w1:t3の2件で、w1:p3には先のsandbox実測出力が残る。SSHでworker uid1000/group workerのみ、password status L、Codex個別ChatGPT login、Herdr0.9.5を再確認した。今回sudoが失敗した対象はこの専用workerであるとユーザーが確定した。

Mac/WindowsのTailscale statusを同時期に取得し、双方BackendState Running、広告されたpublic IPv4は各1件で同一だった。これを異なるpublic NAT越しの検証として数えない。公開endpoint値・認証情報は記録しない。

非rootのdpkg-queryではcanonical APT baseline20件のうち12件が不足（git-lfs/build-essential/pkg-config/libssl-dev/cmake/ninja-build/clang/lldb/tree/unzip/zip/python3-venv）。apt-get -s --no-install-recommends --no-upgrade installの現一覧によるsimulationは終了0、追加73件、既存版更新0・削除0。rootやapt-get updateは実行しておらず、実適用時の再simulationを省略する証拠ではない。

Mac→Windows VPN gateway→WSL専用SSHでzero byte列を1024/65536/1048576/16777216 byte取得し、全てexit0・長さとSHA256一致。1回ずつの経過時間は1.220/1.164/4.501/36.870秒。これは現在のgateway経路でサイズを変えた転送が停止しなかった確認で、圧縮可能データのため性能benchmarkにしない。WSL自身のVPN、二重VPNカプセル化、MTUの最適性・異ネットワークは未検証。
