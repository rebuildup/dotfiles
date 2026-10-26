# 分散ノードの再開検査（2026-10-27 JST）

## 接続復旧

最初のMac→Windows専用SSH nonce検査は失敗し、直接SSHもTCP22222への接続でtimeoutした。Windows担当は専用listener PID49792とWindows VPN `100.118.123.62`の維持、Mac peerのofflineを確認した。

Macの公式Tailscaleアプリを起動すると、既存登録のままConnectedとなった。CLIでBackendState=Running、Self.Online=true、IPv4 `100.83.203.34`、Health空配列を確認。登録・control server・認可設定を変更していない。その後`bun script/devnode.ts verify --name win-uuu-recreated`は既存host pin・専用鍵・nonce一致で終了コード0。初回の失敗と復旧後の成功を分けて記録する。

pc-setupの所有確認付き`control.sh status`では、Mac専用SSHとHerdrのLaunchAgentがrunning（PID5251 / 837）。Herdrは明示した`devnode-poc-mac-14f29b3f-cda` sessionで0.9.5 / protocol22 / compatible=trueを確認した。default sessionの停止状態を専用sessionの障害とは扱わない。これらは今回のHerdr remote API・agent応答の再検証を代替しない。

## WSL設定のレビュー境界

WSL worker instanceは`2a1084ec-5389-4b0b-a0f0-9a38fcfaece5`。Windows担当の設定controller v4をSSH回収し、SHA256 `0e93b0573744df81024ed43b02590cc84a2570cb5410e90f96c0acfeed1e6bca`を照合した。既レビューv3との差分は、信頼するmachine module path、NetTCPIP / NetSecurityの絶対manifest importとcmdlet Source検査、v4専用marker / checkpoint / result名だった。

source `8eb034d07c1b2f14aea7bbe788f75bbe1dd4023a`、source-pins SHA256 `f2893b7af6e26c3d8c1eccd8d0f5512bd1ceb089f0aa584e148156aa1f798478`、既Inspectとwsl.confのhashを維持した一回適用を担当へ依頼した。ネットワークがofflineの間は適用せず、復旧後に開始した。実際のguest設定・gateway・SSHの結果は後続の証拠で確認する。

Codexはユーザーの指定どおりWSL内で個別ログインする。既存Mac / Windowsの認証cacheをコピーしない。

Windows担当の後続報告ではConfigureと対象distroだけのRestartが成功し、`guest-boundary-verify`で失敗した。Hold / gatewayへ進んでおらず、Windows TCP22224は未公開。元のcontrollerを再実行せず、各predicateの読取診断へ進んだ。この報告だけでWSL SSH接続や隔離成立とは扱わない。

[MicrosoftのWSL security model](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)は、WSLを関連Windowsユーザーと同じ信頼水準で扱い、interop / automount設定だけをcontainment boundaryにしないよう説明している。今回も専用の標準Windows SID / ACLと非sudo Linuxユーザーを使う。[Ubuntuのbinfmt解説](https://ubuntu.com/wsl/docs/stable/explanation/binfmt/)を参照し、登録の有無・実効状態・設定を区別して診断する。他distroが共有する状態を無断変更しない。

## 脆弱性情報の再確認

GitHubの公式latest release APIを再確認し、Tailscaleは[v1.104.2](https://github.com/tailscale/tailscale/releases/tag/v1.104.2)、Headscaleは[v0.29.6](https://github.com/juanfont/headscale/releases/tag/v0.29.6)だった。[Tailscale公式bulletin](https://tailscale.com/security-bulletins)の最新掲載はTS-2026-013。既に実施した更新・公開範囲制限の証拠は[10月26日の調査](network-security-2026-10-26.md)を参照する。更新版がTailwormの全指摘を解決したとは判断しない。

VPSへのpin付き管理SSHから、`devnode-headscale-headscale-1`が公式0.29.6 imageでhealthyなことを読取確認した。許可元から`https://headscale.rebuildup.dev/health`はHTTP200 / TLS検証0。外部からの拒否試験や多ノード通信の証拠ではない。

## ローカル検査

再開時の`script/test`、`script/test-workflow`、`script/check-secrets`は終了コード0。workflow中の意図的なtimeout / 不正fixture拒否を検査全体の失敗と混同しない。共通join / leave、worker MI、WSL再生成やHeadscaleでの複数ノード間通信の完成証拠ではない。

現在の`script/secrets-doctor`もsite / project / environment、human login、project access / runtime injectionを含め成功した。
