# Herdr独立共有hostのPoC（2026-10-29）

## 目的

Mac/Windows/WSLをHerdr serverとして固定せず、全端末が同じserver/session/paneに直接attachできる独立hostを用意する。Herdrの複数machine catalogは接続先ごとの独立server/sessionを表示する機能で、単一画面の同期ではない。表示中の画面を共有するには同一Herdr server/sessionへのremote attachが必要。

## 選択したPoC配置

- host: 既存Infisical/Headscale VPS `tastile-infisical` (`157.180.90.160`)
- Herdr: 公式Linux x86_64 v0.9.5。公式`latest.json`のSHA-256 `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`と取得binaryが一致することを確認。
- 実行user: `herdr-shared`。UID/GID 1000の専用user/group、SSH鍵認証のみの運用、Docker group・sudo権限なし。homeとauthorized_keysは本人のみアクセス可能。Docker socketへのアクセス試験とsudo権限試験はいずれも拒否。
- network: 追加listen portやfirewall変更なし。既存SSH TCP/22を利用。
- data: `/home/herdr-shared/work`と専用Herdr state。Infisical/HeadscaleのDocker設定・container・volumeは変更していない。
- credentials: Mac用の新規ed25519 private keyをMacの`~/.ssh/id_ed25519_herdr_shared_vps`に作成。公開鍵だけを専用userへ登録。既存の管理用鍵やWindows/WSLの秘密鍵は流用していない。
- local target: Macの`~/.ssh/config`に`herdr-shared-vps`を追加。Herdr 0.9.5のmise管理binaryで`herdr --remote herdr-shared-vps --session shared`を起動。

## 実測

- SSH host key検証を有効にしたMacからのpublic-key loginが成功し、接続userが`herdr-shared`であることを確認。
- 公式Herdr remote attachでVPS上にnamed session `shared`が作成され、workspace `~` / `w1`、tab `w1:t1`、pane `w1:p1`の単一構成になった。
- 試験nonce `HERDR_VPS_SHARED_20261029`を同一paneへ送り、同じpaneから読み戻せた。
- attach clientをdetachした後も、`herdr session list --json`が`shared`を`running: true`として返し、pane/sessionが残ることを確認。
- Macから同じtarget/sessionへ再attachできることを確認。

## 結論と未検証

このPoCはMacをHerdr server hostから外し、Macが停止してもVPS上のHerdr sessionが残ることを示す。VPSは単一障害点として残り、再起動後の自動起動・復旧はまだ構成していない。Infisicalと同じVMで任意shell/agent codeを動かすため、専用unprivileged userの分離だけではVM/kernel障害境界は分離されない。長期運用採用前に、同居リスクを許容するか、独立VMへ分けるかを決める必要がある。

現時点でSSH許可済みなのはMac用公開鍵だけ。WindowsとWSLの鍵を追加・接続していないため、他端末から同じ画面へ入れるE2Eは未検証。Windows/WSLの鍵を共有・コピーせず、各端末で固有鍵を作り、公開鍵だけを個別登録する。Herdr本体はMacのmise管理版を使う。

```sh
herdr --remote herdr-shared-vps --session shared
```

他端末では`herdr-shared-vps`に同じ表示名のSSH host entryと、その端末固有鍵・host pinが必要。その後`herdr --remote herdr-shared-vps --session shared`を実行する。Herdr clientは全端末で同じserver/sessionに向けること。通常のlocal `herdr`を開くと各端末の独立sessionになり、画面は同期しない。

VPS上にCodex/Claude等のagent runtimeや認証情報は導入していない。agent実行場所・ノード指定、Infisical Machine Identity、node lifecycle、Headscale transport、negative access testは未達であり、この画面共有PoCだけで分散開発基盤の完成とはしない。

## 継続検証

Windows/WSLをofflineと推定して作業を止めた判断を撤回。MacからWindows `basic` とWSL `worker`の専用SSHへ実際に到達した。WSL worker上でVPS用固有鍵を生成し、公開鍵のみVPSへ登録。専用host pin付きSSH認証と公式remote TUI attachが成功し、WSL TUI入力 `WSL_SHARED_LIVE_20261029` とMac TUI入力 `MAC_SHARED_LIVE_20261029` がVPSの同一paneに到達した。Windows専用公開鍵もWindows担当が生成しVPSへ登録済み、Windows TUI実測は進行中。

この共有sessionには非秘密の検証文字列だけを置く。低権限workerが共有sessionへ接続できることを、他nodeを制御する権限の付与と混同しない。

共通受入条件を `docs/herdr-acceptance.md` に固定。`script/test`、`script/test-workflow`、`script/check-secrets` は成功。`script/check` は実HOMEがprimary checkoutを参照していること、OS固有ファイル欠落、Claude composed settingsの差分を報告したため成功扱いにしていない。検査worktreeへ実HOMEを付け替える修正はしていない。
