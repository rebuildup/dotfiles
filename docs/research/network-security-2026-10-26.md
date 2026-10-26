# Tailscale / Headscale セキュリティ確認（2026-10-26）

## 判断

Tailscaleの公式TS-2026-013と、研究者によるTailworm報告を別件として扱う。前者に対する更新を実施した。Tailwormの全指摘を修正済みとは判断せず、不要な機能の無効状態を確認し、Headscaleの公開HTTPSを接続元制限した。悪用コードや負荷試験は共有VPS・実機で実行していない。

根拠は[公式Security Bulletins](https://tailscale.com/security-bulletins)、[Headscale v0.29.6 release](https://github.com/juanfont/headscale/releases/tag/v0.29.6)、[研究者のTailworm報告](https://www.tailworm.com/)。研究者報告の検証対象はTailscale1.104.2 / Headscale0.29.5であり、最新版という理由だけでTailwormへの安全性を推論しない。

## 実際の状態と対応

| 対象 | 確認・変更 | 限界 |
|---|---|---|
| Mac Tailscale | 1.104.2 / Go1.27.3。RunSSH・RunWebClient・AppConnector広告はfalse、Serve設定なし | daemon内部の全状態や脆弱性不在を証明していない |
| Windows Tailscale | 1.102.4から署名・SHA256を確認した公式MSIで1.104.2へ更新。元SelfID・IP・control URL・選択prefs・Serve設定の維持を確認 | 更新直後はNoStateとなり既存GUI起動で回復。ログアウト・再起動後の稼働は未検証 |
| Windows機能 | RunSSH・RunWebClient・AppConnector広告はfalse。既存Serveはloopback TCP宛てのみ、Unix socket・LocalAPI宛てではない | 他用途のServe設定は変更していない |
| Headscale | 0.29.6。メモリー512MiB・pids128、embedded DERP無効、明示deny-all policy | resource limitはDoSの完全修正でも可用性保証でもない。ホストswapは0 |
| Hetzner firewall | 既存のTCP443を全IPv4から27.83.76.30/32へ制限。IPv6の443許可なし。適用先1、Fully applied | この時点でMacとWindowsは同じpublic IPv4。別送信元からのpacket拒否実測は未実施 |
| 公開到達性 | 許可元からHeadscale health HTTP200 / TLS検証成功。Infisical status HTTP200 / TLS検証成功 | 全API・全ノード通信の検証ではない |

Windows更新は最初のMSI実行が1619、次の実行が0だった。成功した更新後にも一時的な接続回復失敗があったため、更新・接続回復を別の結果として記録している。Windows側の詳細ログは同機の`C:/Users/rebui/setup-audit/tailscale-security-20261026/`に保存する。秘密値・daemon state・秘密鍵はGitへ回収しない。

Mac/Headscaleの選択項目とprovider変更は[非秘密JSON](poc/network-security-2026-10-26/mac-and-headscale.json)に記録。標準OpenSSHによるHerdr接続を使用し、Tailscale SSHは使用しない。

## 運用と未完了項目

443の送信元制限は暫定措置。別LANの参加前には、その管理承認済み送信元を追加して到達性を確認する。特定Macを恒久的な親ノードにはしない。TCP80は証明書発行・更新用として維持し、SSH/ICMP・既存Infisicalの設定は変更していない。Infisicalと同居しているため、VPS・ホストネットワーク障害の影響は共有する。

Tailwormに対応する公式修正の確認、採用版への反映と再評価が必要。公開範囲を拡大する前に、適用する修正と残る到達経路を再確認する。独立Headscale Mac userspace daemonは現在停止中で、以前の登録成功を現在の常時接続の証拠にはしない。新規WSL・別ネットワーク・MTU・再起動・完全失効の検証も継続対象である。
