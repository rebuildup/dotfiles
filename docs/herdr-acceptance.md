# Herdr共有操作の受入条件

ユーザーの2026-10-29の指摘に基づく固定要件。接続先の名前やonline表示だけで完成としない。同日、ユーザーは「同じtabを選べば内容が一致すればよい」と明示し、client間の選択tabの自動追従は不要と確定した。

- 操作端末をMacに固定せず、Windows・WSL・Macから同じserver/sessionの同じ実terminalへ接続できる。
- 同じpaneへの入力・出力が全clientに反映され、2つ目のtab/paneも同じIDと内容で参照できる。
- client切断後も作業が残り、再接続で同じsessionに戻る。Mac clientを閉じた状態でWindows/WSLが操作できる。
- 各workerの実作業はそのnodeで実行し、操作端末と実行先を混同しない。空のVPS shellの共有だけでは分散実行の完成としない。
- 各端末の鍵・資格情報は個別に登録し、秘密鍵やagent loginをコピーしない。
- 普段使う起動入口を明示し、別sessionを開くplain herdrとの混同を防ぐ。PoC workspaceを無制限に追加しない。
- 実行node停止時にそのnodeのprocessが停止することと、特定の操作端末への依存を区別する。Herdrのlive process自動移送は実証なしに約束しない。
- VPSを共有表示hostに使う場合、Infisical同居の権限・障害境界を記録する。低権限workerへ共有controllerの権限を暗黙付与しない。

受入証拠はserver/session/workspace/tab/pane ID、実行user/host、各clientの操作と描画内容、切断前後の状態を含める。現在の実測はdocs/researchに保存し、未実測を成功扱いにしない。
