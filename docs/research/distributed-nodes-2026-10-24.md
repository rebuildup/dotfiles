# 分散開発基盤の比較調査と実機検証記録

2026-10-24 JST。調査対象sourceはdotfiles `27e96e905c1415c2c42aeec99f678ced1c9b0b75`を基点とする。調査元checkoutの未コミット変更と別機能branchは本変更へ取り込んでいない。pc-setupは既存実装のread-only調査のみ。

## 責務と既存資産

- dotfiles: Infisical binding/runtime wrapper、`script/agent.ts`のlocal launcher。
- pc-setup: `mise.global.toml`でHerdr導入、`platforms/windows-11/setup-tailscale.ps1`でWindows VPN/WSL転送。
- 現Windows実装はUbuntu/Ubuntu2に2222/2223固定。Infisicalから取得したOAuth client secretで登録鍵を作る方式。今回の設計では発行権限の対象端末への配布と固定2台mappingを再評価する。
- Herdr installed CLI 0.9.5、Infisical CLI 0.44.8、macOS Tailscale 1.102.4。CLI版はserver版の根拠にはならない。

## 比較

| 観点 | Headscale + Tailscale | NetBird | OpenSSH + Infisical |
| --- | --- | --- | --- |
| OS | Mac/Windows/Linux、WSLは経路別試験 | Mac/Windows/Linux、WSLは経路別試験 | OpenSSH利用OS、WSL別sshd |
| NAT/LAN越え | peer直結、DERP fallback | WireGuard直結、Signal/Relay | SSHだけでは解決しない。公開endpoint/踏み台が別途必要 |
| disposable登録 | 短期単回preauth key、ephemeral登録 | one-off setup key、ephemeral peer | 公開鍵配布と撤回を別に行う |
| 発見・名前解決 | 管理API、MagicDNS | peer/groupとDNS | inventory/SSH alias管理が必要 |
| 最小権限 | tag/port policy。Headscale対応範囲に注意 | group/policy | sshd/user/authorized_keys。network認可は別 |
| 性能 | direct/DERP、MTUとrelay経路依存 | direct/relay、MTUとrelay経路依存 | 経路が存在すればSSH直接。VPN比較の実測なし |
| セルフホスト | 公開HTTPS、DB、更新、backup、任意DERP | Management/Signal/Relay等の運用 | 新serviceを減らせるがNAT問題は残る |
| 費用 | compute/storage/転送/domain。追加請求額未算出 | compute/storage/転送/domain。追加請求額未算出 | 到達可能な基盤が既存なら追加server不要 |
| Infisical統合 | 管理者が単回鍵発行→対象限定配布 | 同左。setup key失効とpeer失効は別 | node別MI + 承認済公開鍵metadata |
| 制御面停止 | 新規登録/認可変更停止。既存通信は継続し得る | 開いている直結と新接続/relayの影響を分ける | SSH接続先はInfisical停止と独立。新secret取得停止 |

第一候補は既存Tailscale資産を活用できるHeadscale。これは採用仮説であり、実機の性能・相互運用・障害結果ではない。研究室のfirewall/NAT/通信policyによってrelay到達性を確認する必要がある。

## 一次資料

- [Tailscale WSL2](https://tailscale.com/docs/install/windows/wsl2): Windows+WSLで二重トンネルになる経路はMTU問題を持つ。gateway方式と直接方式を別試験にする。
- [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking): NAT/mirrored modeとfirewallの条件を確認する。
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh): Windows native SSH server共通化には通常OpenSSHを使う。
- [Headscale requirements](https://headscale.net/stable/setup/requirements/): 公開IP/HTTPS 443。内蔵DERPではUDP 3478、HTTP-01では80、remote gRPCでは50443。metricsは公開しない。
- [Headscale policy](https://headscale.net/stable/ref/policy/): policy未指定/空objectはallow-all。初期明示deny-allから必要通信だけ許可する。
- [Headscale DERP](https://headscale.net/stable/ref/derp/): 内蔵/外部relayの選択と到達性を明示する。
- [Tailscale control outage](https://tailscale.com/docs/reference/coordination-server-down): 既存通信と新規認可更新は異なる障害特性を持つ。
- [NetBird setup keys](https://docs.netbird.io/manage/peers/register-machines-using-setup-keys): one-off/ephemeralと、setup key失効では既登録peerを遮断しない点を区別する。
- [NetBird outage behavior](https://docs.netbird.io/manage/peers/lazy-connection): Signal停止時の既存直結と新接続の挙動を比較する。
- [Infisical Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth): client secret使用回数/TTLとaccess token寿命は別。汎用端末でOIDCを仮定しない。
- [Infisical audit logs](https://infisical.com/docs/documentation/platform/audit-logs): self-host利用にはEnterprise licenseが必要と記載。現instanceの契約は未確認。
- [Infisical PAM](https://infisical.com/docs/documentation/platform/pam/overview): SSH機能は実instance/契約確認前に必須化しない。
- [Herdr connecting machines](https://herdr.dev/docs/connecting-machines/)、[CLI](https://herdr.dev/docs/cli-reference/)、[automation](https://herdr.dev/docs/agent-automation/): machine/SSH APIを再利用する。

## 実機で観測したこと

| 操作 | 結果 | 証明できる範囲 |
| --- | --- | --- |
| Herdr machine list --json | 空list | saved remote未登録 |
| Herdr machine/agent/workspace/pane help | 公式CLIと一致 | コマンド存在。遠隔実行成功ではない |
| Infisical metadata照合 | 指定URL/project/dev一致 | binding正当性 |
| 公開status/admin config候補GET | HTTP 403 | 未認証経路でserver版/契約を取得できない |
| 管理host SSH、BatchMode/strict host check | authentication拒否 | この管理鍵ではserver側image/version取得不可 |
| script/secrets-doctor | exit 0 | 既存user login、指定project/dev、process injection可能 |
| Tailscale state初期 | Stopped | cached peer online表示を現接続の証拠には使えない |
| Tailscale up（既存accept-routes維持） | exit 0、Running、self Online | 既存tailnetへのMac再接続。Headscale導入ではない |
| 再接続後UUU peer | Online=false | 当該観測時点で接続PoC成立せず |
| UUUへのTailscale ping | 5秒timeout、exit 1 | peer応答なし。Windows設定の原因特定には不足 |
| UUU TCP 22/2222/2223 probe | nonzero | SSH未接続。ユーザーもSSH未設定と申告 |
| 20:52 JST、Windows起動後UUU peer | Online=true | Windows VPN参加を観測 |
| 同時点Tailscale ping UUU | DERP(tok)経由107ms、pong | Mac–Windows VPN疎通成立。direct未成立、SSH成功ではない |
| 同時点TCP 22 probe | exit 1 | OpenSSH初期設定が必要 |
| Mac loopback一時sshd、127.0.0.1:22229 | 専用key/host pin/nonceでssh-verified | clientの正常経路を実SSHで確認。Windows相互接続ではない |

Tailscale再接続は既存非default設定を保持して実行した。login-server変更、VPN登録鍵発行、既存SSH信頼変更、Windows設定変更、WSL削除、既存Herdr pane操作はしていない。Tailscaleは調査後Runningの状態。Macに今回専用のclient key/PoC instance stateを新規生成した。loopback試験のdaemon/鍵/stateは終了後に撤去した。

## 必須PoCの進捗

| # | 項目 | 状態・必要証拠 |
| --- | --- | --- |
| 1 | Mac–Windows | 部分成立。VPN pong成功、SSH未接続。専用SSH初回設定後にecho往復が必要 |
| 2 | WSL独立論理node | 未検証。固有鍵/MI/endpointとWindowsとは異なるinstance ID |
| 3 | 新WSL追加 | 未検証。3台目以上でも固定名/portに依存しない |
| 4 | 模擬再生成 | 未検証。別ディレクトリ/新instanceで実施、既存WSLは破棄しない |
| 5 | 異ネットワーク | 未検証。許可済研究室PCまたは別回線、direct/relay証拠 |
| 6 | Herdr agent操作 | 未検証。明示profile上のtask/結果SHA |
| 7 | node失効 | 未検証。VPN/SSH/MIの拒否を独立確認 |
| 8 | Infisical停止 | 未検証。本番停止せず隔離processで到達先遮断、既存processも観測 |
| 9 | token再使用拒否 | 未検証。実providerで1回目成功/2回目拒否 |
| 10 | 権限外拒否 | 未検証。network/SSH/secretの各negative test |

## repository gate

基点worktreeで`script/test`と`script/test-workflow`はexit 0。`script/check-secrets`はexit 0。`script/secrets-doctor`もexit 0。`script/check`を実HOMEに向けると元checkoutへのsymlinkや既存missing/driftでexit 1になる。検証のために実HOMEを新worktreeへrelinkしていない。`script/test`内の隔離HOMEではlink/checkが成功する。これは本基盤のE2E成功を意味しない。

接続PoC実装後、exact Bun 1.4.2で`bun test`は58 pass / 26 skip / 0 fail。Windows用skipは実Windows成功の証拠に含めない。追加6検査は冪等な専用key生成、不明state/symlink拒否、入力境界、host fingerprint不一致/変更拒否、SSH失敗時の非成功、接続前のhost pin drift拒否を検査する。独立reviewのpin drift指摘を回帰検査RED→GREENで修正した。

Windows bootstrapは[pc-setup PR #131](https://github.com/rebuildup/pc-setup/pull/131)へ分離した。macOS上のPowerShell contract/parserとCIは成功したが、Windows ACL/firewall/auth/undoは未検証。

## 検証runtimeの補足

通常の`mise exec`開始時に過去upgrade予約の旧版auto-pruneが走ったため中断し、削除済み旧7版を元のversionで復旧した。no-config installの副作用で消えたglobal convenience linkも既存設定/選択targetから復旧した。global/worktree TOML hash一致、current version本体を維持した。検証は既存exact Bun 1.4.2実体とpc-setupの既存Python3.14.9実体による明示fallbackで続行した。これは本PoCに新runtimeを導入した結果ではない。
