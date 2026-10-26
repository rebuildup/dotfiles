# Infisical到達不可の限定試験（2026-10-26）

結果は未解決。MacのCLI0.44.9で通常のlogin / project access / runtime injectionが成功した後、試験子processだけのproxyを本人所有の非listen loopback socketへ向け、`script/with-secrets`からprivate canaryを作るcommandを起動した。本番InfisicalやVPS・既存processは停止していない。

CLIは30秒以内に終了せず、検証harnessがdeadlineで停止した。後続確認でcanaryはなく、既存Mac SSH / Herdr processは生存していた。即時拒否やprovider停止時の完全な挙動は確認できておらず、障害PoCをPASSとしない。[選択結果](poc/infisical-unreachable-2026-10-26/result.json)と[hash](poc/infisical-unreachable-2026-10-26/manifest.json)を保存した。

## 公式sourceから確認した注意点

[v0.44.9のGetAllEnvironmentVariables](https://github.com/Infisical/cli/blob/v0.44.9/packages/util/secrets.go)には、human login経路で到達不可と判定され、暗号化backupが存在する場合に過去のsecretを返す分岐がある。同じ関数でもservice / Machine Identity tokenの分岐とは異なる。human wrapperを、そのまま新規nodeのlive authorization / fail-closed保証として使わない。今回はbackup内容やkeyringを調査・出力していない。

[retry policy](https://github.com/Infisical/cli/blob/v0.44.9/packages/util/retry.go)はone-shot既定3回のretryとINFISICAL_RETRY_* overrideを持つ。[client生成と接続確認](https://github.com/Infisical/cli/blob/v0.44.9/packages/util/common.go)にはそれぞれ明示deadlineのない経路もある。ただし、sourceの存在だけでは今回どこで30秒待ったかを特定できない。proxy拒否を実際に観測した証拠もないため、原因をretryやcacheと断定しない。

次は実secretを含まない隔離project / MIで、cacheの有無・期限切れ・到達不可・復旧を区別し、時間上限と新規command起動の有無を確認する。通常wrapperの既存挙動を未検証のまま変更せず、自動node登録とMIの経路を別に検証する。workerのCodex認証は個別loginという承認済み方針を維持する。
