# SecHack Experiment Codex Package

1. 新しいGitリポジトリのルートへ、このパッケージの内容をコピーします。
2. `START_HERE.md`の指示をCodexへ渡します。
3. Codexが実装後、cleanなGit worktreeルートから`npm run screen-pilot`だけを使い、非参加者専用`device.mode=screen`で全4順序と画面上フグの6秒膨張・保持・6秒収縮を確認します。起動時の`sourceCommit`、固定production設定だけを除外した`sourceTreeSha256`、pilot設定バイトの`configFileHash`と全PILOT JSONLイベントの同名3フィールドが一致することも確認します。2つのSHA-256はGO証跡へ記録し、production候補と機械照合します。直接の`node dist-server/screen-pilot.js`や既存ビルドの流用はしません。
4. `mock`は開発・自動テスト・明示的な模擬リハーサルだけで使用します。
5. 実参加者へ使用する前に、二名の独立照合と研究責任者承認により、固定模擬データ、本人非測定、生体データ非取得、画面上フグへの刺激変更および必要な倫理手続きの完了を確認します。
6. 正式screen用`config/experiment.production.example.json`は`formUrl`を空、`formAudit`を不在とし、フォームその他の外部アンケートをアプリのrelease/start gateへ結び付けません。`docs/FORM_RELEASE_GATE.md`はv1履歴またはアプリ外アンケートの任意資料です。
7. `docs/GO_EVIDENCE.md`に従い、研究チームの非参加者が専用`screen-pilot`経路を3〜5件完走し、研究計画、倫理判断、提示前同意、データ管理、技術パイロット、独立二名照合を同じ設定・アプリ版・追跡source treeへ結び付けます。実参加者、正式研究用ID、外部回答をpilotへ使用しません。

撤回・除外・削除は`docs/DATA_LIFECYCLE.md`に従い、研究責任者が事前承認した外部手順で行います。正式リリースは不可逆な自動変更機能を同梱しません。

このパッケージは、`R8-010-2x2-screen-v3`の実験提示サイトを作るための仕様書です。正式参加者UIと正式production成果物には、外部回答に関する名称・導線・回答誘導、`FORM_*`、`MOCK_REHEARSAL`、`PUBLIC_DEMO`を含めません。各提示のリセット後は中立な`response`で停止し、Operatorの明示確認だけで進めます。USB機器と物理フグも不要です。`serial`による物理版は将来の別プロトコルです。開発用Mock設定と正式screen設定を混同しないでください。
