# 分散ノードの再開検査（2026-10-27 JST）

## 接続復旧

最初のMac→Windows専用SSH nonce検査は失敗し、直接SSHもTCP22222への接続でtimeoutした。Windows担当は専用listener PID49792とWindows VPN `100.118.123.62`の維持、Mac peerのofflineを確認した。

Macの公式Tailscaleアプリを起動すると、既存登録のままConnectedとなった。CLIでBackendState=Running、Self.Online=true、IPv4 `100.83.203.34`、Health空配列を確認。登録・control server・認可設定を変更していない。その後`bun script/devnode.ts verify --name win-uuu-recreated`は既存host pin・専用鍵・nonce一致で終了コード0。初回の失敗と復旧後の成功を分けて記録する。

GUI調査ではTailscaleのLaunch at loginが無効だった。アプリ内からの有効化はOS設定を案内するerrorで適用されなかったため、System Settingsの「一般 → ログイン項目と機能拡張 → ログイン時に開く」へ既存の`/Applications/Tailscale.app`だけを追加し、一覧への反映を確認した。新しい独自LaunchAgentは作らず、VPN接続と既存登録を維持した。アプリ内checkboxは変更されなかったため、OSのログイン項目登録と同一の表示状態とは主張しない。実際の再ログイン / rebootでの自動接続は未検証。

pc-setupの所有確認付き`control.sh status`では、Mac専用SSHとHerdrのLaunchAgentがrunning（PID5251 / 837）。Herdrは明示した`devnode-poc-mac-14f29b3f-cda` sessionで0.9.5 / protocol22 / compatible=trueを確認した。default sessionの停止状態を専用sessionの障害とは扱わない。これらは今回のHerdr remote API・agent応答の再検証を代替しない。

その後、専用Mac sessionへTUIでattachし、shellが待機中のpaneで実際の`HERDR_ENV=1`を確認してWindows profileへ公式remote APIを呼び出した。0.9.5のsnapshotと既存`service_macwin`の応答可能状態を確認後、新nonceへのassistant応答が完全一致した。prompt echoは受け入れていない。[選択結果](poc/resume-2026-10-27/herdr-mac-to-windows.json)には会話IDやraw terminal履歴を含めない。応答後はCodexの利用量に関するモデル変更選択画面が出たが、モデルを変更していない。これはMac→Windowsの現在の実測で、前日の逆方向検証や未完了のWSLへ拡張しない。

## WSL設定のレビュー境界

WSL worker instanceは`2a1084ec-5389-4b0b-a0f0-9a38fcfaece5`。Windows担当の設定controller v4をSSH回収し、SHA256 `0e93b0573744df81024ed43b02590cc84a2570cb5410e90f96c0acfeed1e6bca`を照合した。既レビューv3との差分は、信頼するmachine module path、NetTCPIP / NetSecurityの絶対manifest importとcmdlet Source検査、v4専用marker / checkpoint / result名だった。

source `8eb034d07c1b2f14aea7bbe788f75bbe1dd4023a`、source-pins SHA256 `f2893b7af6e26c3d8c1eccd8d0f5512bd1ceb089f0aa584e148156aa1f798478`、既Inspectとwsl.confのhashを維持した一回適用を担当へ依頼した。ネットワークがofflineの間は適用せず、復旧後に開始した。実際のguest設定・gateway・SSHの結果は後続の証拠で確認する。

Codexはユーザーの指定どおりWSL内で個別ログインする。既存Mac / Windowsの認証cacheをコピーしない。

Windows担当の後続報告ではConfigureと対象distroだけのRestartが成功し、`guest-boundary-verify`で失敗した。Hold / gatewayへ進んでおらず、Windows TCP22224は未公開。元のcontrollerを再実行せず、各predicateの読取診断へ進んだ。この報告だけでWSL SSH接続や隔離成立とは扱わない。

後続で[失敗結果](poc/resume-2026-10-27/wsl-configure-v4.json)をpin付きSSH / exit0で回収し、原本SHA256 `27388856d3ed84e69dd1b5750a2d2dc14afa927e25f9fc3962e23ac311a0cb6f`がWindows担当の照合結果とも一致した。[manifest](poc/resume-2026-10-27/wsl-configure-manifest.json)は原本とGit用JSONのhashを区別する。

追加診断のUACは取り消され未起動だったため、worker本人の標準Windows権限で診断した。大きなEncodedCommandはCreateProcessWithLogonWの[1024文字制限](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)に合わないことを実行前に検出し、短い固定commandとpublic codeのstdin入力へ変更。資格情報は引き続きSecureString経由で、codeのargv / stdinと分離した。

[読み取り診断](poc/resume-2026-10-27/wsl-read-only-diagnostic-v3.json)はNativeExit0 / diagnosticなし、SID1013 / native profile / registry照合成功。鍵・設定の所有権とhashは一致し、Linux UID1000 / worker groupだけ、home0700。port22の待受なし、専用sshdはguest eth0 `172.22.157.236:22224`でactive、host keyもConfigure時と一致した。設定を変更せず、`WSLInterop`登録のenabledが元Verifyの不成立点と特定できた。[診断manifest](poc/resume-2026-10-27/wsl-diagnostic-manifest.json)に原本と保存形式のhashを残す。

[Microsoft upstream実装](https://github.com/microsoft/WSL/blob/72ffe523ed428bad8252a04b6ab7d18f93d16101/src/linux/init/init.cpp)では、共有binfmtの保護と各processのinterop server生成が別に制御される。登録の存在だけで対象workerの実行可否を断定せず、非rootでの実PE起動検査を次段階とする。upstreamの確認をinstalled versionの動作証拠として流用しない。

[PE起動検査](poc/resume-2026-10-27/wsl-pe-probe-v1.json)では、Windows公式署名とhashを確認した`whoami.exe`をworkerの新規private領域へ置いた。Windows上の元binaryは専用SIDで正常動作し、Linux側のcopy hashは一致した。WSLの非rootユーザーからの通常環境とclean環境はいずれもexit1で、エラーの分類は`other`。これだけではinterop拒否も完全な隔離も証明しない。原本と保存版のhashは[manifest](poc/resume-2026-10-27/wsl-pe-probe-manifest.json)を参照する。

[MicrosoftのWSL security model](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)は、WSLを関連Windowsユーザーと同じ信頼水準で扱い、interop / automount設定だけをcontainment boundaryにしないよう説明している。今回も専用の標準Windows SID / ACLと非sudo Linuxユーザーを使う。[Ubuntuのbinfmt解説](https://ubuntu.com/wsl/docs/stable/explanation/binfmt/)を参照し、登録の有無・実効状態・設定を区別して診断する。他distroが共有する状態を無断変更しない。

## 脆弱性情報の再確認

GitHubの公式latest release APIを再確認し、Tailscaleは[v1.104.2](https://github.com/tailscale/tailscale/releases/tag/v1.104.2)、Headscaleは[v0.29.6](https://github.com/juanfont/headscale/releases/tag/v0.29.6)だった。[Tailscale公式bulletin](https://tailscale.com/security-bulletins)の最新掲載はTS-2026-013。既に実施した更新・公開範囲制限の証拠は[10月26日の調査](network-security-2026-10-26.md)を参照する。更新版がTailwormの全指摘を解決したとは判断しない。

VPSへのpin付き管理SSHから、`devnode-headscale-headscale-1`が公式0.29.6 imageでhealthyなことを読取確認した。許可元から`https://headscale.rebuildup.dev/health`はHTTP200 / TLS検証0。外部からの拒否試験や多ノード通信の証拠ではない。

## ローカル検査

再開時の`script/test`、`script/test-workflow`、`script/check-secrets`は終了コード0。workflow中の意図的なtimeout / 不正fixture拒否を検査全体の失敗と混同しない。共通join / leave、worker MI、WSL再生成やHeadscaleでの複数ノード間通信の完成証拠ではない。

現在の`script/secrets-doctor`もsite / project / environment、human login、project access / runtime injectionを含め成功した。
