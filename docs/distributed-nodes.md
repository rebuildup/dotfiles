# 分散開発ノード: 実装・検証計画

状態: 設計承認済み。[Git設定更新・表示名同期](devnode-config-sync.md)を追加実装中。Mac↔Windows Herdr/agent PoC成功、常用化とWSLは継続。prepare/trust/verifyを実装し、Mac→Windowsの専用SSH往復、誤鍵/別user/password-onlyの拒否、撤去後非到達、再Bootstrap後の旧host pin/旧client key拒否と新鍵nonceが実機で成功。join/leave等は未実装。

[Issue #74](https://github.com/rebuildup/dotfiles/issues/74) / [提案ADR](adr/distributed-development-nodes.md) / [調査と証拠](research/distributed-nodes-2026-10-24.md)

[2026-10-27の再開検査](research/devnode-resume-2026-10-27.md): Mac VPN復帰後の専用SSH再成功、常設Mac sessionとHeadscaleの現状態を確認。WSLは設定・再起動後の検査で停止しており、SSH / Herdrの成功には数えない。

## 現在使える接続PoC

`script/devnode.ts`はnode登録やMI発行をしない。machine-localな専用鍵とinstance IDの準備、別経路で確認したhost fingerprintのpin、SSH nonce往復だけを行う。Windows bootstrapは[pc-setup #130](https://github.com/rebuildup/pc-setup/issues/130)が所有する。

```sh
mise run devnode -- prepare --name win-uuu
# prepareはssh-keygenでpassphrase入力。無人PoC用の明示opt-inは --no-passphrase。
# .pubだけを対象Windowsへ渡し、Windows側bootstrapとStartを実行する。
mise run devnode -- trust --name win-uuu --host VPN_IP --port 22222 --user ACCOUNT --fingerprint SHA256:CONFIRMED_FINGERPRINT
# Windows debug listenerはkeyscanで終了するためStartを再実行してから:
mise run devnode -- verify --name win-uuu
```

既定stateは`~/.local/state/dotfiles/devnodes/LABEL/`。鍵はGitや`home/`で管理しない。同名rerunは同じidentityを維持し、不明directoryやsymlinkは採用しない。別環境には別state/鍵を作る。`trust`はfingerprint不一致と既存接続変更を拒否する。`verify`の成功はSSHだけで、Herdr/MIはunverifiedと表示する。暗黙local fallbackはない。PoC clientはmacOSで検証済み、Windows clientのACLは未検証。

このPoCは専用`ssh -F`を使い、既存`~/.ssh/config`を変更しない。Herdr catalog同期/管理Includeは後段の未実装機能である。必要なCLIはpc-setup管理のBun/OpenSSH。ローカルmiseにglobal toolの自動準備がある場合、既存のexact Bun 1.4.2実体で`bun script/devnode.ts ...`を実行する明示fallbackを使える。miseの設定を回避するため別の恒久runtimeを導入しない。

## 1. 接続PoC

WindowsにSSHが未設定のため、最初はWindows上で専用setupを実行する必要がある。pc-setupにOpenSSH capability/service/firewallの検査と、今回専用公開鍵の登録手順を置く。管理者権限が必要なOS操作と一般user鍵登録を分ける。既存authorized_keys/sshd_config/firewall ruleを無断上書きせず、変更前の状態とundoを残す。

Mac側は専用client key、専用SSH configとknown_hostsをmachine-localに作る。private keyの保存先はGit/`home/`外。Windowsが提示するhost fingerprintを別経路で照合する。SSHパスワードやInfisical secretをチャットへ送らない。

Herdrは通常のOpenSSH configを読むため、専用configを作るだけでは接続されない。既存configへ競合検査付き管理Includeを非破壊追加する方式を検証し、専用aliasの`IdentityFile`、`IdentitiesOnly`、`UserKnownHostsFile`、`StrictHostKeyChecking`が`ssh -G`の実効値に現れることを確認する。既存file/foreign symlinkを置換せず、Include位置による既存Host設定の優先順位にも注意する。

Windows TailscaleがOnlineになった後、専用OpenSSH接続でOS/instance/実行userを照合し、双方から小さなnonceを往復する。NAT traversalはVPN側で行い、研究室routerのport開放を前提にしない。現在の既存tailnet PoCとHeadscale PoCは別結果として残す。

この段階が成立するまで後段の本登録は実行しない。

## 2. 安全な登録

pc-setupにnode別OpenSSH/Windows転送の冪等setupを実装する。dotfilesに薄いuser-level node wrapperを置き、mise taskを共通入口にする。globalな`node`実行ファイル名はNode.jsと衝突するため使わない。

予定interfaceは`mise run devnode -- <join|leave|list|status|repair|verify>`。正式command/flagsは接続PoCで必要な情報が判明してから確定する。controller側は既存Infisical user loginで承認、target側は自分のMIだけでruntime取得。roles/path対応が実版で使えるか確認し、読取許可と他path/identity管理拒否の両方を試験する。

testsはID衝突/並行登録、途中失敗からの再試行、secret非出力、別instanceへの権限引継ぎ拒否、provider実応答を対象とする。mockの成功を実機登録の証拠にしない。

## 3. WSL追加・模擬再生成

同一Windows上の複数WSLを、固有instance/鍵/MI/SSH endpointで登録する。転送portはhostごとに衝突検査して割り当て、Ubuntu/Ubuntu2固定にしない。非TCP公開やLAN全体への無制限listenを避ける。WSL→gateway対応の変更がWSLのroleを変更しないことを検査する。

実WSLは破棄せず、新しい隔離stateで再登録を模擬する。旧instanceをretireし、新しいID/鍵/MIで旧表示名を明示的に引き継ぐ。旧token・SSH鍵・VPN nodeによる再参加/操作が拒否され、別nodeが影響を受けないことを確認する。

Windows VPNのみ、WSL VPNのみ、Windows+WSL VPNの3経路を区別する。MTU/interface/route、direct/relay、転送サイズ別成功/失敗、SSH大量転送を記録する。二重実行試験は既存接続を壊さない隔離対象で行う。MTUを根拠なく全体変更しない。

## 4. Herdr相互操作

OS導入はpc-setupに維持する。Herdr catalogは直接編集せず公式CLIを使う。installed 0.9.5で確認済みの構文は次の通り。`SSH_TARGET`はレビュー済専用SSH接続定義を指す。

```sh
herdr machine add SSH_TARGET --label INSTANCE_LABEL --remote-session devnode-poc
herdr machine list --json
herdr machine status PROFILE_ID --json
herdr --machine PROFILE_ID workspace create --cwd REMOTE_REPO --label devnode-poc --no-focus
herdr --machine PROFILE_ID agent list
```

machine addはremote server準備を行うため、read-only probeとは区別する。workspace/pane/agentのIDは返却結果から取得し、別serverのIDを流用しない。agent prompt/wait/readとmachine reconnectは同じprofileを明示する。pane操作はHerdr skillの前提を満たす専用sessionでのみ行い、既存focused sessionを外から操作しない。

`agent start --kind`は任意launcherの指定欄ではない。既存provider launcherはnode-localで起動し、そのprocessをHerdrが検出できるか実機確認する。検出未成立ならlauncher統合を完了扱いにしない。OS/capability selectorは承認済候補を絞るだけとし、複数候補は明示選択する。遠隔失敗時にlocalへfallbackしない。

並列依頼はHerdr公式APIへの独立呼出しで行う。成果物はGit commit/Issue/PRへ保存し、失われ得るterminal履歴だけに依存させない。

## 5. 失効・障害復旧

leave/repairは段階別外部結果を照合する。retiredをactiveに戻すrepairは禁止し、新instance登録を要求する。node一覧はOS、オンライン状態、agent能力、SSH/MI/Herdrの理由コードと最終観測時刻を出す。未検証はunknownでありofflineやauth deniedと混同しない。

失効は既存SSH接続/remote agentの継続も観測し、開いているprocessまで止めたかを区別する。token期限切れ、単回token replay、権限外network port、権限外secret pathを実provider上でnegative testする。Infisical停止試験は本番instanceを止めず、試験processの到達性のみ遮断する。

## 6. 納品・review

実装はOS provisioningをpc-setup、user wrapperをdotfilesへ分け、各repoにIssue/PRとSHA付き検証結果を残す。dotfilesは既存0.3 operating baselineから次のminor defaultとして`release-0-4-0`、pc-setupは0.6 integration後の`release-0-7-0`をmainの既存SHAから作成し、ticket PRのbaseにする。このversion選択は実装者の運用判断であり、完成・リリース・mergeの許可ではない。PoC必須条件が残るためPRはDraftに維持する。

dotfilesは`script/test`、`script/test-workflow`、`script/check-secrets`、適用する`script/check`/`script/secrets-doctor`を実行する。pc-setupの実装時は同repoの`scripts/ci.sh`とOS別検証を行う。未達/未検証の必須PoCが残る限り完成とはしない。

[設定更新と表示名の運用](devnode-config-sync.md) / [Herdr実測](research/herdr-bidirectional-poc-2026-10-26.md)。
