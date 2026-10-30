# Headscale 登録 credential と独立 Mac client の実機 PoC

2026-10-25 JST の実測を、2026-10-26 に machine-local journal から archive した。対象 control plane は `https://headscale.rebuildup.dev`。この記録作業では外部 service へ接続せず、credential の発行・取得・撤回、daemon 起動、既存 source/ADR の変更を行っていない。以下の Running 等は記録時点の snapshot であり、現在の稼働確認ではない。

## 実施境界

Mac の既存 Tailscale GUI とは別の userspace PoC client を対象とした。研究用 harness は専用 `control.sock` と `TS_LOGS_DIR` を明示し、`--login-server=https://headscale.rebuildup.dev`、`--accept-dns=false`、`--accept-routes=false` で登録した。既存 GUI の default socket を登録操作に使わない。通常の join/leave、Windows 登録、peer 間通信の完成を示すものではない。

Homebrew formula の Tailscale 1.104.2、`arm64_golden_gate` bottle の期待 SHA256 と実測 SHA256 はともに `d1c69a256cc4848d70fdde762347b3ae9f90a8612b285aec5d8df976a8a098cd`。[preparation](poc/headscale-enrollment/preparation.json) の stage は `verified-archive-not-extracted` のままであり、この preparation 記録だけを展開・daemon 起動の証拠として扱わない。後続登録結果は別 journal が記録する。

登録用の一回限り・ephemeral preauth key は既存 operator 専用 Infisical project `65933584-7b10-4469-97eb-bc3c920326fb` の `dev` / `/` へ一時保管した。値そのものは archive していない。harness は operator project の名称・org・human admin 一名・Machine Identity ゼロ・group ゼロを照合する。取得した human token と preauth key は process 内で処理し、HTTP 認証/body は curl の stdin config、Mac CLI の auth key は `--auth-key=file:/dev/stdin` と stdin で渡す実装である。argv へ値を展開しない。これは保存済み source による実装確認であり、あらゆる OS/cache/監査経路に値が残らないことの包括的な証明ではない。

## 結果

| 境界 | 実測 |
| --- | --- |
| 登録復旧 | 旧 preauth key ID `1` の expiry を確認後、ID `2` を発行。`reusable=false`、`ephemeral=true`、有効期限 2026-10-25 19:32:43.382 JST |
| 初回 node 登録 | 19:22:59.618 JST、Headscale node ID `1`、address `100.96.0.1`、client `Running` |
| 同じ一回用 key の再利用 | 別 UUID の fresh client で試行し、19:28:45.273 JST までに exit `1`、`NeedsLogin`、credential 拒否理由の検出あり |
| 再利用試験の独立性 | 自然失効前の拒否を確認し、server node count は `1 → 1`。元 node ID `1` だけが残る条件を harness が照合 |
| 登録 credential 撤去 | ID `2` を明示 expire、Infisical の対象 secret を削除し、GET `404`。19:32:19.082 JST に完了 |
| 元 node の継続 | credential 撤去後も元 client の `Running` を確認。node を retire/delete した結果ではない |
| 既存 GUI の前後比較 | 19:11:48.330 JST と 19:26:31.580 JST で `Running`、self ID、IPv4/IPv6 address が一致 |

登録成功は [network-recovery](poc/headscale-enrollment/network-recovery.json)、再利用拒否は [network-replay-recovery](poc/headscale-enrollment/network-replay-recovery.json)、撤去は [credential-cleanup](poc/headscale-enrollment/credential-cleanup.json) が記録する。recovery は先行 `network-enrollment.json` と旧 key を明示しており、最初の試行を無条件な成功へ書き換えていない。先行 journal 全体はこの archive の対象外である。

**再利用拒否の正確な HTTP status は未確認。** journal の exit code、fresh client state、server node count、期限前という条件を証拠とする。harness の stderr 判定は複数の拒否表現を検出するため、`already used` の具体的文言や HTTP `401` / `403` を断定しない。Infisical secret の GET `404` は保存対象の不在を示す別の境界であり、Headscale node 失効や発行済 node key の撤回を意味しない。

既存 GUI の [before](poc/headscale-enrollment/existing-gui-before.json) / [after](poc/headscale-enrollment/existing-gui-after.json) は同じ identity/address の継続を示す。指定された `after.json` ではなく、実在した `existing-gui-after.json` を archive した。この二つの snapshot から、全期間の無停止や全 route/DNS preference の完全一致までは主張しない。

## JSON parser の検証

Headscale 0.29.6 CLI の native Go JSON は false boolean を省略し、protobuf Timestamp を `seconds` / `nanos` object で出力する。発行応答の parser はこれを扱いながら、異なる user、再利用可能/既使用 key、不正 boolean、ephemeral 欠落、期限切れ/過長期限、不正 nanos、空白を含む key を拒否する。list の key は plaintext ではなく masked prefix として照合する。

保存した [helper](poc/headscale-enrollment/headscale-key-metadata.ts) と [純粋 unit tests](poc/headscale-enrollment/headscale-key-metadata.test.ts) は Bun 1.4.3 で **11 pass / 0 fail、16 assertions**。合成 fixture のみを使用し、外部 service に接続しない。helper test の green を実ネットワーク・認可試験の代替にはしない。

## 未検証と継続条件

実機 peer 間の接続、deny-all policy による実 packet 拒否、role grants、MTU、NAT/DERP の各経路、control plane/relay 障害、Windows との同時利用は未検証。現在の証拠は登録 credential の一回性と撤去、独立 Mac client の登録、既存 GUI identity/address の前後一致までである。登録 credential を消しただけで node retirement が完了したとは扱わない。次段階で node/identity の終了条件と peer/ACL 試験を別途定義する。

## archive と再現の注意

[manifest](poc/headscale-enrollment/manifest.json) に元の path、各 snapshot の SHA256、調査範囲を保存した。JSON は全階層の field name を検査し、`key` / `accessToken` / `password` / `secretValue` 等の秘密値 field を含まないことを確認した。key ID、expiry flag、secret name 等は明示的に review した非秘密 metadata として残した。credential 形の文字列検査も行い、private key、daemon state、cache、token、secret の実値を取得・archive していない。

研究用 source は [登録復旧](poc/headscale-enrollment/devnode-recover-mac-headscale-poc.ts)、[再利用拒否試験](poc/headscale-enrollment/devnode-recover-replay-headscale-poc.ts)、[credential 撤去](poc/headscale-enrollment/devnode-cleanup-headscale-registration.ts) を保存した。各々が既存 journal と専用 UUID/path に固定された一回用 snapshot で、`--execute` と fresh journal を要求する。通常 test/bootstrap からは実行しない。再実行は外部 mutation と credential 処理を伴うため、この source を汎用運用 command として流用しない。今回実行したのは純粋 parser tests だけである。
