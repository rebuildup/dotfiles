# Mac・Windows間のHerdr相互接続PoC

2026-10-26 JST。関連: [設計](../adr/distributed-development-nodes.md)、[dotfiles PR75](https://github.com/rebuildup/dotfiles/pull/75)、[pc-setup PR131](https://github.com/rebuildup/pc-setup/pull/131)。Mac↔Windows controller間の相互接続・agent操作を実測した。下記の対象範囲に限定した結果である。

## 対象と境界

既存Tailscale経由のcontroller同士（Mac `rebui`、Windows `UUU\basic`）の検証。標準worker・WSL・Headscale経由の通信やMachine Identityの証明には使わない。各端末で生成した別々のSSH秘密鍵は移動せず、独立したhost keyを外部fingerprintと照合した。forwarding/password認証は禁止したまま。操作するHerdrは今回作成した名前付きsessionのみ。

| 項目 | Mac | Windows |
| --- | --- | --- |
| VPN IPv4 | `100.83.203.34` | `100.118.123.62` |
| SSH port | `22223` | `22222` |
| host fingerprint | `SHA256:JxZZce4cTdp9nNOSeqb/xBP955yC/bjIO6h9AfwY5ig` | `SHA256:jiE0bH0QH92Mc46Eiows6oJIFIEykCUAQqN+bj5ogfY` |
| Herdr | `0.9.5` | `0.9.5` official complete ZIP、side-by-side |
| session | `devnode-poc-mac-14f29b3f-cda` | `devnode-poc-win-20261026` |

Windowsの既存0.9.3を置換せず、公式0.9.5 ZIPのGitHub release API digestと実測SHA256 `d2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf`を一致確認した。ConPTYの3ファイルもmanifest hashと照合。`allow_unelevated_clients=false`を維持し、同じbasicの非昇格clientはPermissionDenied/os error5・exit1。PoCの管理者serverが低権限worker向けという意味ではない。

両端で既存global plugin/hookがないことを確認し、process-scoped `HERDR_CONFIG_PATH`で専用非秘密configを指定。XDG rootは既定のままにした。Herdrのmachine catalogは共有されるため、Windowsに元からあるUbuntu/Ubuntu2 profileの全field一致を確認し、新profileだけを公式CLIで追加する。既存default sessionは操作しない。

## SSHと実行環境

MacからWindowsの既存専用key/pinでnonce・終了コード0を再確認した。逆方向はWindowsで新しいkeyを作り、Mac側に接続元IP制限付きで公開鍵だけを登録した。Windows標準ssh-keyscan 9.5はMac 10.3が提示するKEXに未対応だったため失敗した。Git同梱keyscanで取得したhostkeyを外部fingerprintと照合し、専用known_hostsへ固定した。標準sshには`KexAlgorithms=curve25519-sha256`を指定し、nonceが一致した。serverの暗号設定を緩めていない。

Macでは既存`~/.ssh/config`を変更せず、専用directoryの`ssh` shimから`/usr/bin/ssh -F <専用config>`を実行する。Herdrを起動するたびに同じprivate PATHと専用configを指定する。machine profileはこのPATHや鍵を保持しない。machine statusはbinaryを再発見し、remote APIは保存した絶対binary pathを使えるため、両方を別々に検証する。

Windowsは既存SSH configをbackup・整合確認してから専用alias fileへのInclude一行を追加した。既存xserver/wsl-ubuntu/wsl-ubuntu2の`ssh -G`結果は追加前後でbyte一致した。撤去時は元のbackupを無条件上書きせず、追加後に他の変更がないか確認して今回のIncludeだけを除去する。

## 実測経過

Windows→Macの公式`machine add`は成功し、profile ID `c0f6ac3950c614ced3b168c9e5952183`を返した。labelは`devnode-poc-mac-20261026`。machine statusはreachable/error null、remote workspace listは成功した。新規workspace `w2` / pane `w2:p1`で実行時に組み立てたnonceをreadして照合し、Darwin・rebui・実際の`HERDR_ENV=1`を確認した。

Mac→Windowsの初回machine addは失敗し、profileを保存しなかった。version/protocolの互換性は成立していたが、Windows serverは`detached_server_daemon=false`を返していた。公式v0.9.5のrestart_policyはこのflagがfalseなら登録を拒否する。今回の専用Windows sessionだけを公式`server stop`で停止後、同じ絶対binary・専用configを使って`remote-client-bridge`をstdin EOF付きで起動した。正規daemon（PID46076）は`detached_server_daemon=true`を返し、Macからも再確認した。capability値の偽装や既存serverの停止は行っていない。

## 継続・撤去

Macの機械固有resourceは`~/.local/state/dotfiles/herdr-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/`と`~/.local/state/pc-setup/ssh-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/`。private keyはGitへ格納しない。前者の`herdr-poc` launcherはprivate SSH環境を指定する。Windowsの非秘密実測記録は`C:/Users/rebui/setup-audit/herdr-readonly-20261026/report.md`。

server停止・profile削除・SSH撤去はそれぞれ別操作である。profileを消すだけではserverや鍵を失効しない。既存session/profile、標準sshd、他SSH alias、既存WSLを巻き込まない。再接続のtimeout時は同じmutationを再送する前に対象workspace/pane一覧を確認する。


## 双方向の成功結果

| 検査 | Mac→Windows | Windows→Mac |
| --- | --- | --- |
| official machine add | exit0 / profile `e310d40031e946d9896f29d9f600d317` | exit0 / profile `c0f6ac3950c614ced3b168c9e5952183` |
| machine status / remote API | reachable、0.9.5/protocol22互換 | reachable、remote workspace list成功 |
| 作成した専用agent pane | `w2:p1` | `w3:p1` |
| pane実行結果 | Windows / `UUU\basic` / `HERDR_ENV=1` / nonce一致 | Darwin / `rebui` / `HERDR_ENV=1` / nonce一致 |
| Codex | 0.164.0、`poc_macwin` interactive ready→prompt wait(done)→assistant応答一致 | 0.164.0、`poc_winmac` interactive ready→prompt wait(done)→assistant応答一致 |
| 再接続 | 新CLI processから同一`w3:p1`で別nonceを実行・回収 | 新CLI processから同一`w2:p1`で別nonceを実行・回収 |

assistantの返答はMac→Windows `agent-macwin-cea5754baa2f49caae503d429ecbf49b`、Windows→Mac `agent-winmac-c0b0f6a90117471193bd994d2216271f`。送信promptに文字列が含まれるだけでは成功とせず、agent read内のassistant出力行と一致させた。pane nonceもコマンド文字列をechoした結果と区別するため、prefixとnonceを実行時に結合して確認した。serverは再接続試験中に停止していない。

Windowsの最終照合ではglobal config/default session snapshotのhash、既存Ubuntu/Ubuntu2 profileの全field、既存SSH configの元内容を維持した。標準sshdはStopped/Manual、既存mise Herdr0.9.3も維持。新しいsession・専用agent・profile・SSH資源は確認後も保持している。

## 観測した制限

`terminal.shell_mode=non_login`はPowerShellの`-NoProfile`を意味しない。Windows paneでは既存user profileを読み込み、限定PATHにwinget/miseがないためmodule errorsが出た。Codexは既存user設定・認証・hookも使い、Mac→Windows試験ではhook errorが表示されたが、assistantのnonce応答は一致した。既存hookの修復やagent権限設定の変更は今回の接続試験に含めていない。Herdrのplugin/hook不存在確認と、Codex自身のhook不存在は別である。この環境を低権限worker用のclean env/NoProfile実装として流用しない。

このPoCは既存Tailscale経由。Headscale上の双方向通信、標準Windows worker/WSLからのHerdr、OS/capability選択、自動inventory同期、共通join/leave、常駐起動のOS再起動耐性、失効後のHerdr session終了、障害時の復旧は未検証または未実装。今回の名前やIPを固定の親nodeとして一般化しない。

## 今回の専用接続を再確認する

Macでは通常のglobal SSH設定を変更していないため、専用launcherを使う。

```sh
poc_herdr="$HOME/.local/state/dotfiles/herdr-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/herdr-poc"
"$poc_herdr" machine status devnode-poc-win-20261026 --json
"$poc_herdr" --machine devnode-poc-win-20261026 agent list
"$poc_herdr" --machine devnode-poc-win-20261026 agent read poc_macwin --source recent-unwrapped --lines 40
```

Windowsは専用0.9.5 binaryと今回のTOMLをprocess-scopedで指定し、label `devnode-poc-mac-20261026`を選ぶ。操作元にかかわらず、profile ID・pane IDは対象server側の返却値を使い、`--machine`と`--session`を併記しない。

公式根拠: [machine/bridge実装](https://github.com/herdrdev/herdr/blob/v0.9.5/src/remote/attach.rs)、[daemon生成](https://github.com/herdrdev/herdr/blob/v0.9.5/src/server/autodetect.rs)、[Windows detach判定](https://github.com/herdrdev/herdr/blob/v0.9.5/src/platform/windows.rs)。


## 保存した証拠

非秘密の選択出力と元journalのhashを[Mac→Windows](poc/herdr-bidirectional/mac-to-windows.json)、[Windows→Mac](poc/herdr-bidirectional/windows-to-mac.json)へ保存した。raw terminal履歴やcredential・利用率は含めていない。Windows集約原本のSHA256 `a7a19767d06c870ab0bbb895c0eb10eac8af4be9ad2b4089141864ac57206000`をSSH転送後も照合した。Git archiveはCRLFだけをLFへ正規化し、[manifest](poc/herdr-bidirectional/manifest.json)に原本とarchiveのhashを区別して記録した。machine-localの元journal全体は公開archiveではなく、それぞれの端末に保持する。
