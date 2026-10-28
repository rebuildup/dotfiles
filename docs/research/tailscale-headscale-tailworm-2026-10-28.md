# Tailscale / Headscale Tailworm 対応状況（2026-10-28 JST）

## 確認した情報

- Tailscale は2026-10-28、Tailworm調査を受けた四つの確認済み問題 TS-2026-014〜017 の修正版を v1.104.4 として公開した。公式案内は Tailscale SSH 利用環境に v1.104.4 以降への更新を推奨する。
- TS-2026-014 は Tailscale SSH の Unix socket forwarding による特権socketアクセス、015は認証済みTailscale SSH sessionのメモリ増大、016は Tailscale Serve の Unix backend、017は Serve TLSの HTTP/2 mount間 capabilities race が対象。いずれも v1.104.4 で修正された。
- Headscaleの公式最新releaseは v0.29.6。公式release notesには Go 1.27.3、CA bundle、`x/net` / `x/text` / gRPC のsecurity更新がある。一方、Tailworm調査でHeadscale v0.29.5を対象に記載された未認証resource exhaustionについて、v0.29.6のrelease notesに修正の記載は見つからなかった。
- Headscale PR #3586 は pending-authentication cache の容量制御に関するDraft PRとして表示され、未merge。リリース済み修正として扱わない。

## この環境での実測と影響範囲

- Macのstandalone Tailscale GUI/CLIは v1.104.2。Macの選択済み `debug prefs` は `RunSSH=false`, `RunWebClient=false`, `ServeConfig=null`, `AdvertiseRoutes=null`。従って現時点のMacでは、TailwormのTailscale SSH／Serveの主要な実行条件を確認できなかった。クライアント自体は修正版未満なので更新対象。
- Windowsへ今回の専用SSH鍵でread-only接続し、レジストリと公式CLIの表示で v1.104.2を再確認。`debug prefs` は `RunSSH=false`, `ServeConfig=null`, `AdvertiseRoutes=null`。今回のWindows構成でもTailwormのTailscale SSH／Serve条件は見えなかったが、クライアントの版は修正版未満。
- 公式CLI `tailscale update --dry-run` は 1.104.4を提示。`--yes` は公式1.104.4 amd64 MSIを取得し、署名とAuthenticodeを検証、終了コード0を返したが、約10秒後の実行ファイルProductVersionと更新時刻は1.104.2 / Oct20のまま、serviceはrunning、identityはonlineだった。更新は未完了。Windows管理者/UACを伴うデスクトップ導入経路の確認・適用を再依頼した。
- VPSの前回の読取証拠（10月26日）では公式 Headscale v0.29.6 image / healthy、container memory limit 512 MiB、swap limit 1 GiB、restart policy `unless-stopped`、embedded DERP無効、明示deny-all policy。これは今回の再実測ではない。
- 同日のHetzner firewall証拠ではTCP443は `27.83.76.30/32` のみ、TCP80はACME用にIPv4全許可だった。今回MacからDNS A `157.180.90.160`、HTTP `/health` がHTTPSへ302 redirect、HTTPS `/health` がHTTP200/TLS verify 0を確認した。別public sourceからの443拒否は未検証で、過去のfirewall source範囲が現在も維持されているかも再確認待ち。80番からHeadscale APIへ直接到達しないことをnginx/caddy設定やpacket traceで確認していないため、302観測だけで断定しない。
- Memory limit / restart policy はプロセスのメモリ影響と復旧を限定するが、OOM再起動による可用性喪失を防がず、DoS修正の代替ではない。Rate limitingの有無は未確認。
- Tailscale v1.104.4 macOS `.pkg` を公式 stable package serverから取得。公式 `.sha256` と実ファイルのSHA-256が一致し、Developer ID Installer が Tailscale Inc. (W5364U7YZB)、Apple notarization trusted を確認。`sudo -n` は管理者パスワード要求で失敗したため、インストールは未実施。ファイルは `/tmp/Tailscale-1.104.4-macos.pkg` にあり、管理者認証後に利用できる。既存Tailscale stateやログインは変更していない。

## 次の対応

1. Mac管理者が公式 `.pkg` installerを開き、macOSの管理者認証を完了する。その後 `tailscale version`, backend state, node IP, Windowsとの疎通を再確認する。
2. Windowsで管理者/UACを伴う公式経路により v1.104.4 以降へ更新する。実測で Tailscale SSHとServeはoffだったが、既存 login-server / identityが保持されたこと、バージョン、疎通を再確認する。更新は依頼中。
3. VPSでHeadscale 0.29.6の稼働実体、memory limit、ingress source範囲を再照合する。TailwormのHeadscale DoS項目にリリース済み修正がない間は、管理対象の正当な接続元だけにHTTPSを制限する。HTTP/80のredirect/ACME経路がアプリAPIへ渡らないこと、request-rate controlsを確認する。VPS再起動や無検証の自作patchはしない。
4. Headscale PR #3586のmergeと、後続の正式releaseを監視し、正式版のsecurity fixを確認してからアップグレードを計画する。

## Sources

- [Tailscale: SSH Findings and Fixes](https://tailscale.com/blog/tailscale-ssh-findings-fixes)
- [Tailscale Security Bulletins](https://tailscale.com/security-bulletins)
- [Headscale releases](https://github.com/juanfont/headscale/releases)
- [Headscale PR #3586](https://github.com/juanfont/headscale/pull/3586)
- [Tailworm research report and per-finding status](https://www.tailworm.com/)
- [Tailscale stable packages](https://pkgs.tailscale.com/stable/)
