# SecHack Experiment Codex Package

1. 新しいGitリポジトリのルートへ、このパッケージの内容をコピーします。
2. `START_HERE.md`の指示をCodexへ渡します。
3. 必要に応じて、cleanなGit worktreeルートから`npm run screen-pilot`を使い、非参加者専用`device.mode=screen`で全4順序と画面上フグの6秒膨張・保持・6秒収縮を任意に品質確認します。screen pilotの件数や実施有無は正式release/startのハードゲートではありません。
4. `mock`は開発・自動テスト・明示的な模擬リハーサルだけで使用します。
5. 正式productionはEXTERNAL COMPLIANCE MODEを使用します。承認資料と実施条件は本システム外で管理し、アプリ、設定、Git、CI、manifest、ログへ承認PDF、承認文書ハッシュ、確認者情報を保存しません。
6. 正式screen用`config/experiment.production.example.json`は`formUrl`を空、`formAudit`を不在とし、フォームその他の外部アンケートをアプリのrelease/start gateへ結び付けません。`docs/FORM_RELEASE_GATE.md`はv1履歴またはアプリ外アンケートの任意資料です。
7. 第1提示の開始条件は、`participantMode=enabled`、当日のOperatorセッション内確認、参加者ごとの提示前同意確認、緊急停止、必須runtime checkです。確認に氏名、メール、ID、署名、承認番号、承認文書、SHA-256を入力させず、永続保存しません。

撤回・除外・削除は`docs/DATA_LIFECYCLE.md`に従い、研究責任者が事前承認した外部手順で行います。正式リリースは不可逆な自動変更機能を同梱しません。

このパッケージは、`R8-010-2x2-screen-v3`の実験提示サイトを作るための仕様書です。正式参加者UIと正式production成果物には、外部回答に関する名称・導線・回答誘導、`FORM_*`、`MOCK_REHEARSAL`、`PUBLIC_DEMO`、倫理承認証跡を含めません。各提示のリセット後は中立な`response`で停止し、Operatorの明示確認だけで進めます。USB機器と物理フグも不要です。`serial`による物理版は将来の別プロトコルです。開発用Mock設定と正式screen設定を混同しないでください。
