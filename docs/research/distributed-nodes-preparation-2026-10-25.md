# VPSと新規WSL workerの準備記録

2026-10-24〜25 JSTの観測。実サービスの稼働、設定検証、設計決定を区別する。全体は[Issue74](https://github.com/rebuildup/dotfiles/issues/74)で追跡する。

## VPSへの管理接続

既存Infisical VPSはDebian 13.7 x86_64、Docker 29.8.1、Compose 5.5.1。Windows固有の管理秘密鍵をMacへコピーせず、Windowsの既存認証経路でMac固有の公開鍵だけを追加した。既存authorized_keysをroot専用backupへ保存し、既存行と所有者・modeを維持。Macからhost key pin付きの公開鍵認証成功を確認した。以降のVPS変更はMac側が担当する。

Infisicalのbackendはlocalhost:8080、公開経路は既存cloudflared。postgres/redisは既存stackに所属し、今回停止・変更していない。backend imageは`local/tastile-infisical:devtest-20261006`、image IDは`sha256:878835c6ab5057f039437d7c49bc5328f356ad07fc4c7af4cbf81629075363f8`。OCI versionは`v0.165.15`、revisionは`f030c8c921b0945568c928eef81d1ca453d4199f`。local imageであるため公式版との完全一致は未確認。

約38GiBのdisk中30GiB、3.7GiB RAM中2.2GiBが観測時に利用可能だった。既存database backupのファイルmetadataは見つかったが、定期・off-host backupと復元試験は未確認。同居によるVM障害の共有を解消したとは扱わない。

## Headscaleの設定検証

[pc-setup PR133](https://github.com/rebuildup/pc-setup/pull/133)のcommit `cd849984f6919b642be49c46fa325a396880faa3`を専用のroot専用stageへ転送し、`/srv/devnode-headscale`向けprepareとvalidateがexit 0。既存Infisical stackとは別のCompose project・volumeを使う。

公式Headscale v0.29.6 imageをindex digest `sha256:cabe84f0699913dbca9320f0883dca7565dd08df3c5be29edfabbebeff763966`へ固定した。VPSで実行したversion出力は`v0.29.6+dirty`、commit `a2b1d7863926834e94479dcdd91ab344a9356bd0`だった。公開imageの出力をそのまま記録し、独自buildとは推定しない。

configtestは一時tmpfs stateで実行し、本番DBや登録鍵を作成していない。実際のmanage.sh validateはbridge networkを使う。version表示をnetworkなしで実行した検査とは区別する。設定はnative TLS/HTTP-01、独立IPv4範囲100.96.0.0/16、外部DERP、embedded DERP無効、`grants: []`のdeny-all。後続のDNS登録後にサービスを起動した結果を以下に記録する。VPN peer、user、登録用keyは未作成。

2026-10-25、ユーザー指定のVivaldiのChatGPT拡張経由でCloudflareを操作し、`headscale.rebuildup.dev`のA=157.180.90.160、DNS only、TTL自動を保存した。既存3レコードは維持。gabriel/mia両権威DNSのA応答が同IP、AAAA応答なしを確認した。

その後、所有確認付きmanage.sh applyがexit 0、containerはhealthy。Headscale healthと実行中serverのpolicy checkがexit 0、deny-all policyはvalid。VPSの127.0.0.1:80へのHost付きHTTP要求は302だった。ただしMacから公開80/443へのTCP接続はいずれも8秒でtimeout。HTTPは`--resolve`でVPSのIPを明示したため、resolverの古いnegative cacheだけでは説明できない。公開TLS・ACME成功は未検証であり、サービス起動成功を公開利用可能と扱わない。provider firewall等の上流経路は次の調査対象で、原因はまだ断定しない。

Infisical backend/db/redisのcontainer ID・開始時刻・再起動回数・running状態は起動前後で一致し、公開`/api/status`も前後ともHTTP 200。既存Infisicalの再起動は発生していない。Headscale専用service/volumeは保持する。

## WSLの既存状態と新規workerの境界

Windows担当の読取調査では、既存Ubuntu一台のみがWSL2で稼働していた。WSL 3.0.4.0、Ubuntu 26.04.1 LTS、systemd有効。Linux sshdは未導入、Linux Tailscaleも未稼働。Windows側Tailscaleは稼働していた。Linux PATHにはWindows側shimが混在し、CLI名の存在だけではLinux runtimeの動作証拠にならない。

既存UbuntuからWindows管理鍵のpathを`test -r`で確認するとtrueだった。鍵の内容は読んでいない。rwの`/mnt/c`とWSLInteropが有効で、同一Windowsユーザー配下のWSL追加だけを低権限分離とは扱えない。

ユーザーは2026-10-25に「新規workerをOS権限でも分離する」を選択。[pc-setup Issue134](https://github.com/rebuildup/pc-setup/issues/134)はworkerごとの標準Windowsユーザーと固有WSLを対象とする。既存Ubuntuや管理用profileを変更しない。OS passwordはSecureString/process内で扱い、管理者のtoken/env/cacheを渡さない。新規user/profile起動とACLを実測してから登録へ進む。アカウント作成・WSL import・MI付与・Herdr操作は、この記録時点では未実施。

Windows調査ログは当該端末の`C:\Users\rebui\setup-audit\wsl-readonly-20261024\result.txt`、VPS調査ログは同`vps-readonly-20261024\result.txt`に保持する。秘密情報を含む環境全体やcontainer inspect全体をリポジトリへ転記しない。
