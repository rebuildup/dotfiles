# 開発ノードの設定更新とHerdr表示名

共通の非秘密設定はこのGit repository、秘密鍵・host pin・Herdr session・認証cacheは各端末が所有する。これらを丸ごと他端末へコピーしない。OSと常駐起動はpc-setupが所有する。

## Gitから更新する

更新専用のclean checkoutを使う。初回cloneは通常のGit、以後は次の入口で対象branchを明示する。未merge検証中は`74`、release後は管理者が選んだrelease branchを使う。実行中の別作業checkoutや既存HOMEリンクを無断で切り替えない。

```sh
bun script/devnode.ts update check --repo /absolute/path/to/runtime-checkout --branch 74
bun script/devnode.ts update apply --repo /absolute/path/to/runtime-checkout --branch 74
# 同じ入口は mise run devnode -- update ... でも利用できる。
```

canonical HTTPS/SSH origin、現在branch、clean状態、取得commitへのfast-forwardを確認する。dirty/untracked、ahead/diverged、別originを自動修復しない。ignored fileも上書きせず、hooks・自動maintenanceを起動しない。activeなGit content filterはstatus実行前とtarget treeで検査し、必要なら手動更新へ止める。使われていないfilter定義だけでは拒否しない。初期化済みsubmoduleも、statusによる再帰実行を避けるため手動更新へ止める。runtime cloneではsubmoduleを初期化しない。private credentialsやcacheは更新対象ではない。

fetchはremote refを読むためネットワークと通常のGit認証を使う。HTTPS認証は既存`gh auth setup-git`を利用し、account passwordを設定しない。更新はコード取得であり、tool install、HOMEへのlink適用、service再起動、node登録は別操作。取り込まれる差分を確認し、常駐processへの設定反映は所有するpc-setup手順で行う。client/serverの版と互換性を再検証する。

## Herdrの表示設定を適用する

[config/devnode-machines.json](../config/devnode-machines.json)は表示名のdesired stateであり、node認証registryではない。`name`は設定参照keyで、node UUID、物理hostname、Herdr profile IDと区別する。現在の表示名は`UUU · Windows`と`Mac · macOS`。

各端末で、SSH host pin/nonceとofficial machine addを確認した登録だけをprivate bindingへ記録する。`herdr machine list --json`の実際のID・target・session・labelを使う。次はMacの今回所有する接続例であり、他端末へコピーする汎用値ではない。

```json
{
  "version": 1,
  "bindings": [{
    "name": "win-uuu",
    "profileId": "e310d40031e946d9896f29d9f600d317",
    "target": "devnode-win-uuu-recreated",
    "session": "devnode-poc-win-20261026",
    "expectedLabel": "UUU · Windows"
  }]
}
```

private fileをGit/`home/`の外へ保存する。POSIXは本人所有0600、直近parentは本人所有かつ他ユーザー書込不可とする。Windowsは本人所有fileと保護されたparent DACLを使い、本人・SYSTEM・Administrators以外に変更権を与えない。wrapperは権限を検査するだけで、自動的に緩和しない。祖先directoryの全権限を再帰検証するものではないため、第三者が置換できない信頼したユーザーstate配下を選ぶ。binary/config/stateの端末固有pathも同期しない。

```sh
bun script/devnode.ts machines plan --bindings /private/path/machines.json --herdr /absolute/path/herdr
bun script/devnode.ts machines apply --bindings /private/path/machines.json --herdr /absolute/path/herdr
bun script/devnode.ts machines status --bindings /private/path/machines.json --herdr /absolute/path/herdr
```

今回のMacでは`--herdr`に、専用SSH configを選ぶ既存の`~/.local/state/dotfiles/herdr-poc/mac-14f29b3f-cda1-4acf-9f18-26d35f8d6074/herdr-poc`を指定する。Windowsでは対応版の完全packageの`herdr.exe`を絶対pathで指定し、専用`HERDR_CONFIG_PATH`はそのprocessだけへ渡す。Herdr0.9.5以降を要求する。

planは変更予定だけを表示する。applyは期待したprofile ID/SSH target/session/現在labelが一致する登録を、公式`machine rename`だけで更新する。完了したlabelをprivate bindingへ保存し、次のGit更新でも同じ所有接続として再調停できる。部分失敗は完全成功にせず、catalogを確認して同じdesired stateで再実行する。外部UIから同じprofile/bindingを同時編集しない。

新しい接続はunboundとして表示され、自動adopt/add/removeしない。既存Ubuntu/Ubuntu2も変更しない。別環境や再生成先へ表示名を引き継いでも、instance・SSH trust・MI権限を自動継承させない。

## 検証範囲

Git updateはlocal Git remotesによるfast-forward/dirty/diverged/ignored file/filter/hook拒否を検証した。Macのcanonical originの専用cloneで実際のfast-forwardと次回noopを確認。Mac/Windowsの所有profileに対するplan/apply/noopを検証したが、既にdesired labelだったため、このadapterによる実機renameは発生していない。Windows ACL guardもCI/実機で確認した。

WindowsではBunのrealpathが8.3短縮名を保持しGitが長い名前を返す差を実測し、非ゼロdirectory dev/inoの一致でrootを照合するよう修正した。Git fixtureはlocal core.autocrlf=falseに固定し、SSHの選択出力はCRLFを正規化する。Windowsのnative process起動試験には30秒の上限を設ける。global Git設定は変更しない。[選択結果と対象SHA](research/poc/config-sync-2026-10-26/results.json)を参照。

LinuxはCIを確認し、Linux/WSL実機への適用と新WSLの接続bindingは未検証。テストやGit更新の成功をnode参加成功とは扱わない。
