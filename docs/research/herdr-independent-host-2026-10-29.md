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
