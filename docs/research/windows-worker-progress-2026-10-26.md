# Windows常設SSH・新規WSLの段階検証（2026-10-26）

## 確認した範囲

Windowsの専用SSHをOS起動タスクへ移し、新規の標準Windowsユーザー本人によるWSL2 import・登録照合・最初のLinux起動まで確認した。WSLの専用SSH・Herdr・worker MI・再生成の完成証拠ではない。既存Ubuntuは変更していない。

| 段階 | 結果 | 根拠 |
|---|---|---|
| 本人Windows profile / registry | SID1013、標準ユーザー、canary非継承、初期登録0 | [Inventory / Import](poc/windows-worker-2026-10-26/inventory-import-and-config-sync.json) |
| 管理領域への拒否 | 管理鍵はHANDLE取得拒否、operator directoryは列挙拒否 | 同Inventory。秘密鍵の内容は読んでいない。別worker間の拒否ではない |
| 新規WSL import | ImportCommandSucceeded true、本人registryで専用distro / base path / WSL2を照合 | 同ImportReport / VerifyReport。各操作の真偽を混同しない |
| 初回Linux起動 | Ubuntu24.04 / x86_64 / UID0、nonce一致、CPU2 / memory4013088KiB | [Boot](poc/windows-worker-2026-10-26/wsl-initial-boot.json)、pc-setup source42639b08 |
| 初回WSL境界 | Windows mountとinteropは有効だった | Bootの実測。非root化・抑制設定・guestからの拒否は後続 |
| Windows専用SSH待受 | SYSTEMのnative OpenSSH、VPN IPv4:22222、元host keyを維持 | [遅延起動後の選択結果](poc/windows-worker-2026-10-26/windows-ssh-task.json)、管理source b39bba1、[PR140](https://github.com/rebuildup/pc-setup/pull/140) |
| Macからの認証 | 元pin・専用鍵・nonce / exit0を再確認 | `bun script/devnode.ts verify --name win-uuu-recreated`。接続PoCのclient metadata UUIDはWindows node identityではない |

worker instanceは`2a1084ec-5389-4b0b-a0f0-9a38fcfaece5`。SIDは実行所有者の属性で、論理IDと区別する。各段階はsource/controllerのhashとCreateNew markerで一回実行し、失敗時は部分状態を保持した。passwordはoperatorのInfisical projectから一時SecureStringへ取得し、argv・環境変数・Gitには保存しない。workerにoperator projectの資格情報を渡していない。

## Windowsタスクの実機差分と復旧

最初のInstallは登録後の厳密XML照合で失敗した。Windowsが既定値の項目を省略し、UseUnifiedSchedulingEngineをtrueへ変換していた。APIのACL表現も保護flagを省略してSYSTEM読取ACEを追加していたが、実Task fileは保護済みAdministrators / SYSTEMだけのFullControlだった。

既知schema defaultの欠落だけを補い、未知項目は拒否する検査へ修正した。実Task fileの保護ACLとAPIの実効ACEを別々に照合する。旧XML hash・SDDL・runtime source / manifest・enrollment SID・VPN状態を確認した一回controllerから、公式API SetSecurityDescriptorのみでACLを修復した。Task fileの直接書換え、runtime source4file・鍵・SSH config・firewallの置換は行っていない。

Verify / Start後5秒の検査は待受がまだなく失敗した。その失敗結果を保持し、再Startせずに後続の読取検査でPID49792の専用待受を確認した。標準sshdはStopped / Manualを維持。boot triggerの実行やOS再起動後の復帰は未検証であり、待受開始だけで合格としない。

## 認証・接続の次段階

WSL用にはMacで新しいdevice-local client keyを生成した。秘密鍵は移動せず、公開鍵だけをWindows担当へ渡した。この接続用metadataをWSL instance UUIDの代用にしない。WSL内の固有host keyも生成し、別経路で指紋を確認してからMacでpinする。

承認済ADRに従い、初期PoCはWindowsを交換可能なgatewayとして使う。候補は既存IP HelperによるVPN IPv4:22224から本人WSLのeth0 IPv4:22224への限定TCP転送と、controller送信元だけのfirewall許可。これはまだ適用前の設計で、既存22222のOpenSSH forwarding禁止は維持する。共有gatewayのVPN identityをWSL独自のnetwork identityとは扱わない。

ユーザーはCodexをWSL内で個別ログインする方針を選択した。Mac / Windowsのlogin cacheをコピーせず、API keyを自動共有しない。Linux非rootユーザー、mount / interop / Windows PATH抑制、専用sshd、固有host pin / nonce、Herdr / runtime準備を段階検証してからログインする。worker MIはこの段階では未発行。

## 証拠の保存と限界

[manifest](poc/windows-worker-2026-10-26/manifest.json)にWindows担当が報告した原本SHA256と、pin付きSSH回収後に一致した値、Git用JSONのhashを分けて記録した。原本は端末内、Gitには非秘密の選択報告だけを保存する。古い集約報告の未実施値は、その観測時点の履歴として残す。後続Boot / 待受報告で過去の報告を改変しない。

WSL非root化・SSH / Herdr接続、複数worker間拒否、再生成・旧資格情報拒否、worker MI、Headscale peer / MTU / 異ネットワーク、OS再起動は未検証。Task / agent processの存在だけを認証や安全なjoin完成の証拠にしない。

追記時のdotfiles `script/test`（隔離HOMEのcheckを含む）、`script/test-workflow`、`script/check-secrets`、diff検査は成功。一方、Macの`script/secrets-doctor`はCLI0.44.9 / site / project / env照合まで成功し、human login sessionがmissing or rejectedで失敗した。以前の成功を現在の認証証拠には数えず、再認証とprovider確認を継続課題とする。

同日、その後self-hosted URLを明示した正規CLI browser loginで再認証し、`script/secrets-doctor`のlogin / project access / runtime injectionを含む全検査が再成功した。既存Vivaldiの認証完了画面も確認した。資格情報・profile cacheは端末内に保持し、他nodeやGitへコピーしていない。
