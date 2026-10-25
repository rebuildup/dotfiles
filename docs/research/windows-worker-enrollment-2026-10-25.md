# 標準Windowsユーザーによるworker登録準備

関連: [pc-setup PR135](https://github.com/rebuildup/pc-setup/pull/135)、[設計](../adr/distributed-development-nodes.md)。2026-10-25 JST。実アカウント間の分離、WSL import、MI登録、Herdr E2Eはこの記録時点では未検証。

## ソースの検証範囲

pc-setup commit `80243a3e2d3738aace84ddd4d6963deb6e7ff72f`でWindows worker・PowerShell・shell・Nixの全CIがsuccess。Mac側と独立reviewerが、admin所有metadata/probeの非書込ACL、SID/group照合、clean env/NoProfile、registryエラーのfail-closed、アクセス拒否と不在/IO異常の区別を確認した。重要なソース欠陥は見つからなかったが、実account/profile/alternate credentialの検証を代替しない。既存UbuntuとSSHを変更しない。WSL import/unregisterは当該sourceに未実装。

Windows controllerのInfisical 0.44.4で、明示domain `https://secrets.rebuildup.dev/api`に対応する既存human user sessionがauthenticatedであることを確認した。別domainのsessionやコマンドexit 0だけでは判定していない。token/cacheの内容は出力せず、他端末のtokenをコピーしていない。

## Operator専用の秘密情報境界

既存dotfiles bindingを維持し、OS account passwordには別projectを作った。

| 非秘密pointer | 値 |
| --- | --- |
| instance | `https://secrets.rebuildup.dev` |
| project | `65933584-7b10-4469-97eb-bc3c920326fb` |
| project name | `devnode-operators-04decc5b-c71a-4c96-9e05-bb622909d864` |
| environment / path | `dev` / `/` |
| first worker instance UUID | `2a1084ec-5389-4b0b-a0f0-9a38fcfaece5` |
| expected Windows account | `pcw-2a1084ec5389` |
| secret key name | `WINDOWS_PASSWORD_2A1084EC_5389_4B0B_A0F0_9A38FCFAECE5` |

空project作成後とpassword格納直前に、直接のproject membershipがhuman admin一名・Machine Identityゼロ・groupゼロであることをAPIで確認した。これは組織管理者からの隔離を主張するものではない。組織管理者は信頼済みoperatorとして扱う。worker MIをこのprojectへ追加してはならない。現在planのfolder/environment RBACを認可境界に使わず、project全体をoperator用にする。

最初のpasswordは乱数で生成し、Infisicalへ格納してメモリ内readback一致を確認済み。値をチャット・argv・環境変数・平文ファイル・Gitへ保存していない。CLI user tokenもprocess内capture、curlの認証header/bodyはstdin configで渡し、curlrcとredirectを無効にした。ログは非秘密pointerと検査結果のみ。このpasswordは対象OS account専用であり、共有join passwordやノードMI credentialではない。

Windows側では自分のhuman loginで指定secret一つだけをprocess内captureし、SecureStringへ変換してProvision/PrepareProfileへ渡す。取得失敗・空値・不正値はOS作成前に停止する。取得helperと署名済みfresh imageの準備結果を確認するまで実accountを作成しない。子workerへoperator tokenや環境を継承しない。次のworkerには別UUID・別passwordを発行し、既存accountのpassword resetで使い回さない。

## 次の実機gate

1. 公式Ubuntu fresh imageの署名とSHA256を標準検証ツールで確認する。既存Ubuntuのexportを使わない。
2. 対象一台の標準accountとprofileのみを作成し、identity・group・ACL・再実行・環境非継承を確認する。
3. 別workerを準備して管理鍵と相互dataの拒否を確認する。一台だけの現在token試験をクロスuser分離の証拠にしない。
4. 新規WSLのimportとネットワーク、MI、Herdrへ段階的に進む。WSL unregister/破棄は行わない。

現状はpasswordの中央保管と取得手順の準備まで。Infisical secret-access監査が無効という未達要件は残る。退役時はOS accountの停止と、このinstance専用credentialの撤回を独立して記録する。
