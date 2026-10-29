# Tailscale / Headscale Tailworm 対応状況（2026-10-28〜30 JST）

現在の状態（2026-10-30 JST）：TailscaleはMac/Windowsとも修正版1.104.4。Headscale0.29.6は未修正の上流問題と現行edge制限の未確認が残るため、登録node0のPoCコンテナを一時停止した。以下の旧観測は履歴であり、末尾の再確認・停止結果を優先する。

## 確認した情報

- Tailscale は2026-10-28、Tailworm調査を受けた四つの確認済み問題 TS-2026-014〜017 の修正版を v1.104.4 として公開した。公式案内は Tailscale SSH 利用環境に v1.104.4 以降への更新を推奨する。
- TS-2026-014 は Tailscale SSH の Unix socket forwarding による特権socketアクセス、015は認証済みTailscale SSH sessionのメモリ増大、016は Tailscale Serve の Unix backend、017は Serve TLSの HTTP/2 mount間 capabilities race が対象。いずれも v1.104.4 で修正された。
- Headscaleの公式最新releaseは v0.29.6。公式release notesには Go 1.27.3、CA bundle、`x/net` / `x/text` / gRPC のsecurity更新がある。一方、Tailworm調査でHeadscale v0.29.5を対象に記載された未認証resource exhaustionについて、v0.29.6のrelease notesに修正の記載は見つからなかった。
- Headscale PR #3586 は pending-authentication cache の容量制御に関するDraft PRとして表示され、未merge。リリース済み修正として扱わない。

## この環境での実測と影響範囲

- Macのstandalone Tailscale GUI/CLIは v1.104.2、upstream stableは v1.104.4。`debug prefs` は `RunSSH=false`, `RunWebClient=false`, `ServeConfig=null`, `AdvertiseRoutes=null`。Macの実行環境ではTailscale SSH / Serveは無効。
- Macのmise Homebrew backendは `brew-cask:tailscale` を `tailscale-app` caskとして検出し、既インストール版1.102.4（auto-updates）と表示する一方、`mise.global.toml`にはcask宣言がない。実行中Appが自動更新を担うため、`mise bootstrap packages upgrade brew-cask:tailscale --dry-run`はskipした。standalone variantの `SUAutomaticallyUpdate=1` と `SUEnableAutomaticChecks=1` を確認したが、Tailscale app本体はこの観測時点で1.104.2のまま。mise側更新経路に統一する方針を確認し、standalone pkgは適用していない。したがって1.104.4の導入は未完了。
- Windowsへ今回の専用SSH鍵でread-only接続し、レジストリと公式CLIの表示で v1.104.2を再確認。`debug prefs` は `RunSSH=false`, `ServeConfig=null`, `AdvertiseRoutes=null`。今回のWindows構成でもTailwormのTailscale SSH／Serve条件は見えなかったが、クライアントの版は修正版未満。
- 公式CLI `tailscale update --dry-run` は 1.104.4を提示。`--yes` は公式1.104.4 amd64 MSIを取得し、署名とAuthenticodeを検証、終了コード0を返したが、約10秒後の実行ファイルProductVersionと更新時刻は1.104.2 / Oct20のまま、serviceはrunning、identityはonlineだった。更新は未完了。Windows管理者/UACを伴うデスクトップ導入経路の確認・適用を再依頼した。
- VPSの前回の読取証拠（10月26日）では公式 Headscale v0.29.6 image / healthy、container memory limit 512 MiB、swap limit 1 GiB、restart policy `unless-stopped`、embedded DERP無効、明示deny-all policy。これは今回の再実測ではない。
- 同日のHetzner firewall証拠ではTCP443は `27.83.76.30/32` のみ、TCP80はACME用にIPv4全許可だった。今回MacからDNS A `157.180.90.160`、HTTP `/health` がHTTPSへ302 redirect、HTTPS `/health` がHTTP200/TLS verify 0を確認した。WindowsからのHTTPS healthもHTTP200だったが、Windowsのegress IPを比較していないため別public sourceからの443拒否試験とは数えない。過去のfirewall source範囲が現在も維持されているかも再確認待ち。80番からHeadscale APIへ直接到達しないことをnginx/caddy設定やpacket traceで確認していないため、302観測だけで断定しない。
- Memory limit / restart policy はプロセスのメモリ影響と復旧を限定するが、OOM再起動による可用性喪失を防がず、DoS修正の代替ではない。Rate limitingの有無は未確認。
- Tailscale appの公式Sparkle自動更新設定は有効。CLIの `update --dry-run` はこのstandalone macOS buildで「not supported on this platform」を返したため、miseが報告したself-update boundaryを迂回していない。Tailworm修正版の実適用と、既存node identity・接続保持は未確認。
- Mac側の最新再確認でもTailscaleは1.104.2のまま。ユーザー方針に従いMacの導入・更新経路はmiseに統一し、別配布pkgは適用しない。mise cask管理は実行中Appの自己更新境界でupgradeをskipし、AppのSparkle自動更新は有効だが、修正版への更新時期は保証されていない。
- Windowsの現在値は1.104.2。Computer Useのアクセス許可要求APIがこの接続で利用できず、Windows desktop/UAC更新は未実施。VPSのknown_hosts pinとWindows管理鍵候補 `bps-ssh.pem` を使ったread-only SSHを試したが、root公開鍵認証は拒否された。秘密鍵内容は閲覧しておらず、別鍵は試していない。Headscaleの現行版、container digest、ingress/memory設定は再確認できていない。VPS変更なし。

## 次の対応

1. Macのmise-managed cask/App updaterがv1.104.4を適用した後、version、backend state、node IP、Windowsとの疎通を実測する。auto-update設定は有効だが適用時期は未確定。
2. Windowsで管理者/UACを伴う公式経路によりv1.104.4以降へ更新し、既存login-server / identity、version、疎通を再確認する。
3. 正しい管理接続とhost identity確認が得られたらVPSの実稼働Headscale version、memory limit、ingress source範囲を再照合する。TailwormのHeadscale DoS項目に正式release修正が確認できるまで、曝露面とrate limitを確認し、未検証patchやVPS再起動はしない。
4. Headscale PR #3586のmergeと後続正式releaseを追跡する。2026-10-29の確認ではPRはopen / Draft。

## 2026-10-29 再確認・mise更新経路

- Tailscale公式の2026-10-26 bulletinと10-28 remediation記事を再確認した。Tailworm対応版は1.104.4以降。Mac実機は1.104.2、Windowsも1.104.2で、両方とも修正前である。公式は特にTailscale SSH利用者へ更新を推奨する。
- Macはユーザー方針に合わせ、pc-setupのmise global package宣言へ`brew-cask:tailscale`を追加し、miseのcask経由で1.104.4を適用する。起動中アプリはmiseが「自動更新アプリ」としてskipすることをdry-runで確認した。アプリを終了してmise applyを実行すると、公式1.104.4 macOS pkgの`sudo installer`実行時に管理者パスワード待ちになった。認証がまだ提供されていないため、インストール未完了。現時点のアプリ版は1.104.2で、アプリ終了によりMacのtailnet通信も停止中。mise cask installer完了後にアプリを再起動し、版・BackendState・peer疎通を再検証する。
- Windowsは公式1.104.2のまま。2026-10-29のWindows taskで、現在のUUU\\basicセッションは`ADMIN=False`のため更新は実行していない。UACを伴う公式更新と認証保持の確認待ち。
- Headscale実稼働環境の前回確認版は0.29.6。2026-10-29に公式releaseと[#3586](https://github.com/juanfont/headscale/pull/3586)を再確認し、後者はまだDraft。確認済みrelease noteではTailworm報告の未認証pending-authentication resource-exhaustion修正は確認できず、0.29.6や最新であることを理由に修正済みとは扱わない。VPSへ管理SSHできず、現行稼働版・設定・外部到達範囲は今回再確認していない。
- Tailscaleノード更新とHeadscale更新は管理権限が異なる。現在のローカル管理者権限不足とVPS管理SSH失敗により、更新は未完了。未検証patchの適用やVPS再起動はしていない。

## Sources

- [Tailscale: SSH Findings and Fixes](https://tailscale.com/blog/tailscale-ssh-findings-fixes)
- [Tailscale Security Bulletins](https://tailscale.com/security-bulletins)
- [Headscale releases](https://github.com/juanfont/headscale/releases)
- [Headscale PR #3586](https://github.com/juanfont/headscale/pull/3586)
- [Tailworm research report and per-finding status](https://www.tailworm.com/)
- [Headscale PR #3586](https://github.com/juanfont/headscale/pull/3586)
- [Tailscale stable packages](https://pkgs.tailscale.com/stable/)

## 2026-10-29 後続の版確認

- Mac実機の`/Applications/Tailscale.app/Contents/MacOS/Tailscale version`は`1.104.4`、`status --json`の`BackendState`は`Running`、Tailscale IPv4は`100.83.203.34`。公式TS-2026-014〜017の修正版最低版を満たし、peerもonlineを確認した。Macの更新はmise管理`brew-cask:tailscale`経路で適用済み。別配布経路は使っていない。
- Windows側の専用管理タスクから、Tailscale CLI、実行中IPN app、daemonがすべて`1.104.4`、BackendState=`Running`と確認。再起動・設定変更なし。
- 同じWindows管理SSH経路でHeadscale Compose `/srv/devnode-headscale/compose.yaml`とhealthy containerを確認。実行versionは`v0.29.6+dirty`、commit `a2b1d7863926834e94479dcdd91ab344a9356bd0`、build time `2026-10-24T09:21:24Z`。変更・再起動なし。
- Headscale upstreamの最新release notesはv0.29.6で、Go 1.27.3、CA bundle、`x/net` / `x/text` / gRPCの更新を記載する。一方、Tailwormのpending-authentication負荷を有限化する[PR #3586](https://github.com/juanfont/headscale/pull/3586)は2026-10-29時点でDraft。従って現在版を最新と確認できても、そのTailworm findingは解消済みと主張しない。
- 現行Headscaleに対するHetzner firewall ingress、reverse proxy rate limiting、port 80のrouteは、この版確認では再確認していない。前回の保存済みsnapshotは443を単一IPv4 source `/32`へ制限、80をACME用IPv4許可としているが、現在値・別送信元拒否・HTTP routeは未検証。別ネットワークのnodeをHeadscaleへ登録する前に再確認する。
- Windows側でVPSを読み取り確認したところ、Caddy/nginx/Traefik/HAProxyは導入されておらず、調査したHeadscale/proxy設定にもrate-limit directiveはなかった。Composeはhost `0.0.0.0:80`をHeadscale container `8080`へ、`0.0.0.0:443`を`8443`へ直接mapする。`cloudflared.service`はactiveだが、unitから実効ingress policyは確認できなかった。MacからHTTP GETした`/health`、`/key`、`/ts2021`はいずれも同じHTTPS pathへの302だった。HTTP endpointがredirectすることは確認したが、外部HTTPSの拒否やrate limitを証明する結果ではない。
- VivaldiでHetzner Consoleのsecurity verification後、対象projectのfirewall一覧に`tastile-infisical-ssh-only`が`Fully applied`、4 rules、1 serverとして表示された。詳細画面を開くブラウザークリックは操作層で2回失敗したため、現在のCIDR ruleは取得できていない。firewall・VPS設定・serviceの変更はしていない。最後に保存したrule snapshotはTCP443の送信元を`27.83.76.30/32`、TCP80をACME用IPv4許可としているが、現行値は未確認。
- 対応状況: Tailscale nodeは修正版`1.104.4`。Headscaleは`v0.29.6+dirty`で、Tailwormのpending-authentication resource-exhaustionに対する上流修正は未確認。過去のingress allowlist、512 MiB memory limit、128 PID limit、restart supervisionは封じ込め策に過ぎず、修正の証明にもservice interruptionの防止にもならない。現行allowlistを維持し、firewall policyと上流対策を確かめるまで新しい送信元networkから登録しない。IPv4/IPv6全体へ公開範囲を広げない。この報告のHeadscale影響はcontrol/registration availabilityに関するもので、peer dataの機密性侵害を示す証拠はない。

## 2026-10-30 上流再確認と公開停止

公式確認では最新正式releaseは依然[v0.29.6](https://github.com/juanfont/headscale/releases/tag/v0.29.6)。[#3586](https://github.com/juanfont/headscale/pull/3586)はDraft解除済みだがopen・未mergeで、修正版releaseは未確認。[#3587](https://github.com/juanfont/headscale/pull/3587)は登録前のlock map増大を扱い未merge。[#3571](https://github.com/juanfont/headscale/issues/3571)はmetrics listener無効でも未登録Noise clientへmetricsが露出する報告で、通常HTTPS path filterではNoise内部を制限できない。準備中の0.29.7 [#3625](https://github.com/juanfont/headscale/pull/3625)も未release。最新正式版という理由で安全とは判定しない。

VPSの再実測ではHeadscale0.29.6+dirty、commit `a2b1d7863926834e94479dcdd91ab344a9356bd0`、image digest `sha256:cabe84f0699913dbca9320f0883dca7565dd08df3c5be29edfabbebeff763966`。登録nodeは0。deny-all policy、embedded DERP無効、memory512MiB/CPU1/PID128/capdropALL/no-newprivilegesは維持されていた。DockerはIPv4/IPv6全interfaceで80/443を公開し、hostのDOCKER-USERは空、source allowlist/rate limitを確認できなかった。Hetznerの現行CIDRは未確認。Vivaldiに接続したChrome extensionへ管理画面tabを作る操作がtimeoutし、その空tab取得がbrowser URL policyで拒否されたため、別browserやraw CDP等で回避していない。

現行公開面を保証できず、Headscaleを利用中のnodeもないため、VPS管理SSHで今回所有する`devnode-headscale-headscale-1`だけを`docker stop`した。事前に登録0、image digest、Compose所有root `/srv/devnode-headscale`、restart policy `unless-stopped`を確認。停止後は`exited 0 unless-stopped`、host TCP80/443のlistenerなしを確認した。コンテナ・設定・DBを削除していない。

同時点でInfisical backend/DB/Redisは稼働し、`https://secrets.rebuildup.dev/api/status`はHTTP成功・message Ok・redisConfigured=trueを返した。Mac→Windows/WSLの既存Tailscale経路はHeadscaleを使っておらず、Herdr実作業への接続と切り離せる。この一時停止は上流修正の適用ではなく公開面を閉じる暫定措置。

再開前に、正式修正releaseのadvisory・対象digestを確認し、既存stateのbackup後にpc-setup管理Composeを更新する。先にHetzner IPv4/IPv6双方の443 source制限または同等のhost制限を確認・検証し、認可されたsourceだけでhealth/TLS/policyを検証する。公開範囲を広げたまま起動しない。既存コンテナの単純復帰操作は`docker start devnode-headscale-headscale-1`だが、上記gatesを満たす前の日常起動手順としては使わない。停止によるACME更新停止も含め、再開時は証明書有効性を再確認する。

停止後にMac/Windowsの公式CLIを再実行し、双方`1.104.4`を再確認。`devnode machines status`はWindows/WSL両方reachableを返した。Headscaleの停止を既存Tailscale peer接続の停止と混同していない。
