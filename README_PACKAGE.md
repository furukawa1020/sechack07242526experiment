# SecHack Experiment Codex Package

1. 新しいGitリポジトリのルートへ、このパッケージの内容をコピーします。
2. `START_HERE.md`の指示をCodexへ渡します。
3. Codexが実装後、正式な`device.mode=screen`で全4順序と画面上フグの6秒膨張・保持・6秒収縮を確認します。
4. `mock`は開発・自動テスト・明示的な模擬リハーサルだけで使用します。
5. 実参加者へ使用する前に、研究責任者と第三者レビューで、固定模擬データ、本人非測定、生体データ非取得、画面上フグへの刺激変更および必要な倫理手続きの完了を確認します。
6. `docs/FORM_RELEASE_GATE.md`を完了し、正式screen用`config/experiment.production.example.json`を承認済み監査値で封印します。

このパッケージは、`R8-010-2x2-screen-v1`の実験提示サイトを作るための仕様書です。Googleフォーム本体、実データ、USB機器、物理フグは含みません。`serial`による物理版は将来の別プロトコルです。開発用Mock設定と正式screen設定を混同しないでください。
