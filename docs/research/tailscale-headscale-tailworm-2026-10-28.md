# Tailscale / Headscale Tailworm 対応状況（2026-10-28 JST）

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
- Windowsの現在値は1.104.2。Computer Useのアクセス許可要求APIがこの接続で利用できず、Windows desktop/UAC更新は未実施。Windows担当は既存管理SSHキーからHeadscale VPSの過去SSH aliasを解決できず、DNS failureを確認して認証前に停止。現在のHeadscale版、container digest、ingress/memory設定は再確認できていない。

## 次の対応

1. Macのmise-managed cask/App updaterがv1.104.4を適用した後、version、backend state、node IP、Windowsとの疎通を実測する。auto-update設定は有効だが適用時期は未確定。
2. Windowsで管理者/UACを伴う公式経路によりv1.104.4以降へ更新し、既存login-server / identity、version、疎通を再確認する。
3. 正しい管理接続とhost identity確認が得られたらVPSの実稼働Headscale version、memory limit、ingress source範囲を再照合する。TailwormのHeadscale DoS項目に正式release修正が確認できるまで、曝露面とrate limitを確認し、未検証patchやVPS再起動はしない。
4. Headscale PR #3586のmergeと後続正式releaseを追跡する。2026-10-29の確認ではPRはopen / Draft。

## Sources

- [Tailscale: SSH Findings and Fixes](https://tailscale.com/blog/tailscale-ssh-findings-fixes)
- [Tailscale Security Bulletins](https://tailscale.com/security-bulletins)
- [Headscale releases](https://github.com/juanfont/headscale/releases)
- [Headscale PR #3586](https://github.com/juanfont/headscale/pull/3586)
- [Tailworm research report and per-finding status](https://www.tailworm.com/)
- [Tailscale stable packages](https://pkgs.tailscale.com/stable/)
