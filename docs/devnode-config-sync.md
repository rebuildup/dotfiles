# 開発ノードの設定更新とHerdr表示名

共通の非秘密設定はこのGit repository、秘密鍵・host pin・Herdr session・認証cacheは各端末が所有する。これらを丸ごと他端末へコピーしない。OSと常駐起動はpc-setupが所有する。

このdesired-state同期はHerdrの接続先表示名だけを調停する。Herdr machine catalog/profileはクライアントごとのローカル参照であり、端末間の画面・pane・workspace・agent sessionを共有しない。複数端末で同じ画面を操作するには、全クライアントから同一のHerdr serverと同一のsessionへ公式remote接続する。各端末のローカルdefault sessionを開いたままでは画面は別々になる。

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

[config/devnode-machines.json](../config/devnode-machines.json)は表示名のdesired stateであり、node認証registryではない。`name`は設定参照keyで、node UUID、物理hostname、Herdr profile IDと区別する。現在の表示名は`UUU · Windows`、`Mac · macOS`、`WSL · worker 1`。

各端末で、SSH host pin/nonceとofficial machine addを確認した登録だけをprivate bindingへ記録する。`herdr machine list --json`の実際のID・target・session・labelを使う。次はMacの今回所有する接続例であり、他端末へコピーする汎用値ではない。

```json
{
  "version": 1,
  "bindings": [{
    "name": "win-uuu",
    "profileId": "3202e4b584c237bb11db58dddc10d640",
    "target": "devnode-win-uuu-recreated",
    "session": "default",
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

今回のMacでは`--herdr`に、mise管理下の`/Users/rebui/.local/share/mise/installs/herdr/0.9.5/herdr`を指定する。実作業の接続先は通常のHerdr machine catalogに登録済みの専用SSH aliasを使用する。旧PoC wrapperや旧PoC sessionを日常の起動先にしない。Windowsでは対応版の完全packageの`herdr.exe`を絶対pathで指定し、専用`HERDR_CONFIG_PATH`はそのprocessだけへ渡す。Herdr0.9.5以降を要求する。

planは変更予定だけを表示する。applyは期待したprofile ID/SSH target/session/現在labelが一致する登録を、公式`machine rename`だけで更新する。完了したlabelをprivate bindingへ保存し、次のGit更新でも同じ所有接続として再調停できる。部分失敗は完全成功にせず、catalogを確認して同じdesired stateで再実行する。外部UIから同じprofile/bindingを同時編集しない。

新しい接続はunboundとして表示され、自動adopt/add/removeしない。既存Ubuntu/Ubuntu2も変更しない。別環境や再生成先へ表示名を引き継いでも、instance・SSH trust・MI権限を自動継承させない。2026-10-29にMacの検証用WSL profileを`wsl-worker-1` private bindingで明示所有し、desired label `WSL · worker 1`への公式renameを実適用した。他ノードのHerdr catalogは自動同期されないため、そのnodeに登録済みのprofile ID/target/sessionを個別にbindingし、各nodeでapplyする。これは接続参照の同期であり、同じ画面を作る仕組みではない。

## 検証範囲

Git updateはlocal Git remotesによるfast-forward/dirty/diverged/ignored file/filter/hook拒否を検証した。Macのcanonical originの専用cloneで実際のfast-forwardと次回noopを確認。Mac/Windowsの所有profileに対するplan/apply/noopを検証した。2026-10-29にはWindowsの実Mac接続profileを、この同期入口で`Mac · macOS`へrenameした。Windows ACL guardもCI/実機で確認した。

WindowsではBunのrealpathが8.3短縮名を保持しGitが長い名前を返す差を実測し、非ゼロdirectory dev/inoの一致でrootを照合するよう修正した。Git fixtureはlocal core.autocrlf=falseに固定し、SSHの選択出力はCRLFを正規化する。Windowsのnative process起動試験には30秒の上限を設ける。global Git設定は変更しない。[選択結果と対象SHA](research/poc/config-sync-2026-10-26/results.json)を参照。

LinuxはCIを確認し、Linux/WSL実機への適用と新WSLの接続bindingは未検証。テストやGit更新の成功をnode参加成功とは扱わない。

## source更新と所有済み表示設定を一度に同期する

```sh
mise run --skip-tools devnode -- sync --repo /absolute/path/to/runtime-checkout --branch 74 --bindings /private/path/machines.json --herdr /absolute/path/to/mise-installed/herdr
```

必要なBunとHerdrはpc-setup/miseで先に導入する。`--skip-tools`は他の未導入global toolの自動installationをこの同期操作で始めないためのmise標準option。インストール経路の変更ではない。

同期はprivate bindingの所有・権限と現在のHerdr profileを検査し、既存のbounded Git updaterでcanonical originの明示branchをfast-forwardする。その後、更新したcheckoutのコードで所有済みprofileの表示名を適用する。部分失敗時はsourceがどのcommitになったかを報告し、巻戻しやlocal fallbackを行わない。同じbindingへの並行syncは拒否する。

これは既存のsource更新と表示設定適用をまとめた入口。SSH資格情報、認可、Herdr session内容、OSサービス、HOMEリンクの配置は各ownerの操作が必要。起動時の実行を構成する場合も、pc-setupのOS別起動機構からこの明示コマンドを呼び、認証・binding・checkout driftで失敗した場合はその状態を残す。未認証nodeへの権限付与や未知profileの自動登録を行わない。

同じflagsで`sync`を`open`にすると、同期が成功してからその端末の通常Herdr clientを起動する。これを日常の起動入口にすれば、新規常駐schedulerを導入せず起動時のsource/表示名更新を実行できる。同期失敗時はTUIを自動起動せず、そのエラーを表示する。開く先は各端末の実local defaultと公式machine profileで、VPSの試験sessionへの強制接続ではない。

## 今回のMacで検証した短い起動入口

専用runtime cloneに端末固有の`mise.local.toml` task `nodes`を置き、次で実際の起動・切断を確認した（2026-10-30）。

```sh
mise -C /Users/rebui/.local/share/dotfiles-node-runtime-74-20261029 run nodes
```

このtaskは`open`へ上記のprivate bindingとmise管理Herdrの絶対pathを渡す。local task fileはそのcloneの`.git/info/exclude`へ登録し、Git更新のclean判定を妨げない。`[settings.task] run_auto_install = false`を設定し、無関係なglobal toolの自動導入を起動操作に混在させない。新しい端末ではpath・binding・検証済みprofileをその端末用に構成する必要があり、このMac専用pathをコピーしない。

観測：branch `74`を`1288919`から`9f12c79`へfast-forwardし、所有profileは変更不要、通常`default`の実workspaceとWindowsのAe_Restroを表示した。WSL workerは再接続待ちであり、この起動成功はWSL復旧やOS再起動後の自動復旧を証明しない。
