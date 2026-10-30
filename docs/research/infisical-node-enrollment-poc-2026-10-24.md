# Infisicalノード登録primitiveの実機PoC

2026-10-24 JST。対象は既存self-hosted `https://secrets.rebuildup.dev`。Windowsの専用SSH再生成試験後に、登録用資格情報と失効処理の前提を調べた。共通join/leave、WindowsへのMI配布、ネットワーク認可の完成ではない。

## 実施範囲と秘密情報の境界

既存human user loginで、runごとに専用projectとorg role `no-access`のMachine Identityを一つだけ作った。projectのbuilt-in `viewer`を付与し、`dev`に試験専用の合成値一つを置いた。既存dotfiles projectの権限・値は変更していない。他projectへの拒否試験は、存在しない一意の試験キー名を使い、実在する秘密値を要求していない。

Universal Authのaccess tokenはTTL/Max TTL各120秒、Period=0。client secretはTTL120秒、使用回数1。登録用credential/token/合成値はprocess内だけで扱い、curl configをstdinへ渡した。argv、ログ、Git、plaintext環境ファイルへ保存していない。curlは先頭`-q`で既定curlrcのtrace/output等を無効化し、redirectを禁止した。既定curlrcを無視する挙動は、合成curlrcを用いて確認した。

作成・撤去IDと結果だけを非秘密journalへ記録した。全runで試験用Identity/projectの撤去とGET404を確認済み。最初のrunは初回cleanupが失敗したが、原因調査後に所有確認付きで復旧した。秘密鍵・SSH設定・VPN登録・ライセンス・課金設定は変更していない。

## 仕様の根拠

- 実instanceの公開[OpenAPI](https://secrets.rebuildup.dev/api/docs/json)を取得し、実際に存在するrequest/response schemaを参照した。schema SHA256は各journalに保存している。
- OpenAPIの`info.version=0.0.1`はAPI schemaの識別値で、Infisical server releaseではない。後続のVPS調査では、実稼働backendはOCI label `v0.165.15`を持つlocal devtest imageだった。公式releaseそのものと同一とは扱わない。[image識別と調査範囲](distributed-nodes-preparation-2026-10-25.md)を参照。
- [Universal Auth公式仕様](https://infisical.com/docs/documentation/platform/identities/universal-auth)のclient secret使用回数/TTLとaccess token寿命の区別に従った。

## 結果

| 検査 | 実測 |
| --- | --- |
| org role no-access + 専用project viewer | 作成/付与200 |
| 一回限りのcredentialで初回login | 200、token TTL/Max TTLは120秒以下 |
| 同一credentialの再使用 | 有効期限内に401 |
| 専用project/devの合成secret読取 | 200、期待値一致 |
| viewerによる同secret書込 | 有効なtokenで403 |
| 既存dotfiles projectの試験キーへのアクセス | 有効なtokenで403 |
| project membership削除 | 旧形式/現行形式のAPIとも200。現行形式では直後のmembership GET404も確認 |
| membership削除後の発行済token | 有効期限内にsecret GET200が継続。即時拒否の検査は失敗 |
| 削除試験の独立性 | membershipを再付与し、同じtokenのsecret GET200を再確認してからIdentity自体を削除 |
| Identity削除後の発行済token | 自然失効前に401 |
| Identity削除後の未使用credential | 削除直前に発行した未使用・期限内の別credentialも401 |
| 試験資源の撤去 | 各runのIdentity/projectでDELETE200、その後GET404 |

拒否応答の前後で、発行要求開始時を起点とした保守的な期限を検査した。自然失効や既使用credentialを、削除による失効の証拠に流用していない。

## 発見した制約と実装への判断

**membership削除の200やmetadataの404だけでは、発行済tokenの即時失効を保証しない。** 実測したのは削除直後の読取継続であり、継続時間や原因は未確定。キャッシュや伝播遅延と断定しない。

nodeをretireする実装は、membership削除だけを成功条件にしない。instance専有MIの削除、旧tokenと未使用資格情報の拒否、ネットワーク/SSH側の撤回をそれぞれ確認し、未確認をpendingとして残す。今回Identity削除で拒否されたという証拠を、別の版・別instanceや全ての認可経路の即時失効保証には拡張しない。

org planで`rbac=false`/`secretsFolderRbac=false`/`auditLogs=false`を確認したため、細粒度role/pathやsecret-access監査は前提にできない。built-in viewerはproject全体の権限であり、`--env=dev`指定は認可境界ではない。許可されない環境・roleのデータを同じprojectへ混在させず、project単位のデータ分離を設計する。監査要件は未達として残す。

## 失敗の診断と復旧

最初のrunでは、本文なしDELETEへ`Content-Type: application/json`を付けると500になった。削除対象のmetadataは残っていた。同じ対象・認証でそのヘッダーだけを外すと200になり、GET404を確認できた。helperはbodyがある要求だけにJSON用Content-Typeを付けるよう修正した。

Identity GETのouter `identity.id`は組織メンバーシップIDで、Identity本体は`identity.identity.id`と`identity.identityId`。POST応答のIdentity IDとouter IDを混同しない。cleanupはnested Identity ID/nameとorgを照合し、所有確認に失敗した状態を無断削除しなかった。

## 証拠と再現上の注意

- [最初のrunと復旧記録](poc/infisical-enrollment/01-header-failure-recovered.json): `failed-cleaned`。初回失敗を成功へ書き換えていない。
- [旧形式membership APIのrun](poc/infisical-enrollment/02-legacy-membership-revocation.json): `failed`。membership削除後の読取継続を記録し、試験資源は撤去済み。
- [現行membership APIと独立したIdentity削除試験](poc/infisical-enrollment/03-current-membership-revocation.json): `partial-failed-checks`。即時membership失効の失敗を残したまま、Identity削除後の拒否を別に確認した。
- [最終runの実験用harness](poc/infisical-enrollment/harness.ts): journalのsource SHA256と一致するsnapshot。共通bootstrapや常用commandではなく、このMacの既存CLI実体と一時schema pathを参照する診断用source。通常のtestからは実行されず、`--execute`なしでは説明だけを表示する。

harnessの実行は既存human loginで一時的な外部資源を作る。再実行を通常のtest gateへ組み込まない。全ての検査がgreenだったとは扱わず、membership撤回だけに依存できないことを次の実装・review条件へ引き継ぐ。

## 2026-10-30 読み取り再確認

VPSのbackend imageは引き続きlocal/tastile-infisical:devtest-20261006、image ID sha256:878835c6ab5057f039437d7c49bc5328f356ad07fc4c7af4cbf81629075363f8、OCI v0.165.15/revision f030c8c921b0945568c928eef81d1ca453d4199f。10月6日起動/RestartCount0。backend/package.jsonの1.0.0は製品version根拠ではない。公開OpenAPIは10/24の保存schemaとSHA256が一致した。製品release公式版との完全同一性は未確認。

MI/Universal Auth、一回用client secret TTL120秒/uses1、cross-project読取403、viewer書込403、Identity削除後tokenと未使用secretの期限内401は上記の既存実機証拠を再利用する。membership削除だけでは既発行tokenが使えたためretire条件にはしない。target worker内の取得・注入、再生成nodeと旧MIの拒否は引き続き追加E2Eが必要。

このinstanceのclient secret fieldsはttl/numUsesLimit。token更新・撤回は/api/v1/auth/token/renewと/api/v1/auth/token/revokeで、最新docsのuniversal-auth/renewをそのまま移植しない。Period=0を保ち、client secret寿命とtoken寿命を区別する。

今回の読取では認証token/cache/license keyを取得せず、CLIにもplan読取commandが見つからなかったため現行planは未再取得。10/24のrbac=false/secretsFolderRbac=false/auditLogs=falseは履歴として扱う。[公式RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls)でもbuilt-in viewerはproject全体の権限で、custom roleはEnterprise。path/env flagsを認可境界にしない。[監査ログ](https://infisical.com/docs/documentation/platform/audit-logs)のself-hosted Enterprise要件もあるため、secret-access監査は未達のまま。通常SSH接続ログやwrapper実行ログをその代替とは表示しない。自動課金・license変更は行っていない。
