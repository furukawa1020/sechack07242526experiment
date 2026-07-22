# 本番リリース二名照合票

この票はアプリへ入力せず、研究計画で承認された管理方法で保管します。実参加者の氏名・回答・生体情報は記入しません。

> **現時点の人対象本番判定はNO-GOです。** ソフトウェアは実機不要の正式`screen`モードへ移行済みですが、[Googleフォーム公開内容監査](FORM_AUDIT.md)の未解決所見、提示前同意記録方法、画面刺激版の研究計画・倫理判断・データ管理との整合、screenパイロット、独立二名照合、研究責任者承認が未完了です。下記ブロッカーがすべて解消されるまで参加者へ提示してはなりません。

Googleフォームは、実運用設定の`formUrl`に次のURLが設定される前提です。

`https://forms.gle/BeShY7cY5zMjunto9`

## 本番GOブロッカー

- [ ] `docs/FORM_AUDIT.md`の未解決所見が0件となり、修正後のフォームを二名で再監査した
- [ ] 本番設定の`formAudit`が全機械ゲートを満たし、本番preflightとproductionサーバ起動が成功した
- [ ] 本番設定の`goEvidence`が研究計画、倫理判断、提示前同意、データ管理、3〜5件のscreenパイロット、独立二名照合を対象設定SHA-256へ結び付け、全機械ゲートを満たした
- [ ] 研究責任者が、本人を測定しない固定模擬データ・生体データ非取得・画面上のフグを用いる版を承認した
- [ ] 物理フグ版から画面刺激版への変更に必要な研究計画変更・倫理手続きを完了した
- [ ] 提示開始前の同意確認・記録方法と、研究用IDによるフォーム回答・ローカル提示順の連結方法を承認した
- [ ] `device.mode=screen`、空の`serialPath`、物理フグ・USBシリアル・生体センサ未接続を確認した
- [ ] 画面上の6秒膨張・保持・6秒収縮、継続接続中のサーバ時刻同期、`result`/`reset`中の再読み込み時のSTOP・DEFLATE・`error`・再開不能、他フェーズのOperator確認待ちを当日構成で完走した
- [ ] 単一インスタンスロックをサーバ起動へ統合し、二重起動拒否とstale lock回復を最終リリースでテストした
- [ ] 最終の全コマンド実行結果、テスト件数およびカバレッジを`docs/TEST_REPORT.md`へ確定値で記録した
- [ ] 下記の全チェック項目を二名で照合し、未確認項目がない

## リリース識別

- リリースディレクトリ名:
- 生成元Git commit（40文字）:
- 生成元repository（manifestに記録された場合）:
- appVersion:
- protocolVersion:
- 生成日時:
- Windows版・アーキテクチャ:
- Node.js版:
- 設定ファイル名:
- 設定ファイルSHA-256:
- 設定内容SHA-256:
- 対象設定SHA-256（`criticalConfigSha256`）:
- GO証跡SHA-256:
- HEAD追跡source tree SHA-256（production設定だけを除外）:
- source／appVersion／設定／証跡binding SHA-256:
- リリースmanifest SHA-256:

## 公開レビューとMockリハーサル（本番GO判定外）

公開デモの自動リハーサルは、ページメモリ内だけで4提示と画面上のフグ動作を固定時間どおりに再現する。研究用ID、同意、フォーム、ログ、API、WebSocket、装置アダプタ、実機命令は使用しない。`npm run test:public-demo`で1366×768、1920×1080、390×844、320×568、844×390の5画面幅を25テスト・skipなしで確認する。

ローカルの密封Mockリハーサルは、`npm run rehearsal`またはクリーンな作業ツリーから生成した`sechack-mock-rehearsal-*`の`START_MOCK_DEMO.cmd`を使用する。loopback、MockDevice、空のフォームURL、`data/mock-sessions/`への分離ログ、`DEMO-001`形式の模擬IDだけを使用する。公開自動リハーサルとMockリハーサルは、本番の同意、フォーム受入、研究承認、screen本番preflightの代替にしてはならない。

## ソフトウェア受入

- [ ] `npm run lint`成功
- [ ] `npm run typecheck`成功
- [ ] `npm test`成功。最終件数を`docs/TEST_REPORT.md`へ記録
- [ ] `npm run test:e2e`成功。定義されている全ケースをskipなしで完走し、最終件数を`docs/TEST_REPORT.md`へ記録
- [ ] `npm run test:public-demo`成功。5画面幅・25ケースをskipなしで完走し、外部能動通信がない
- [ ] `npm run build`成功
- [ ] リリース生成直前の`git status --short`が空で、追跡・未追跡の変更がない
- [ ] `npm run release:source-evidence`のappVersion、対象設定SHA-256、pilot設定バイトSHA-256、source tree SHA-256が二名照合時と一致
- [ ] production設定が固定パスでGit追跡され、作業ツリーのバイト列がHEADと完全一致
- [ ] `git rev-parse HEAD`の40文字commitとmanifestの`sourceCommit`が一致
- [ ] manifestの`sourceRepository`に認証情報がなく、承認済みrepositoryと一致（フィールドがある場合）
- [ ] 条件マッピング、順序割付、ステートマシン、装置アダプタ、ログ許可フィールドの最終カバレッジを`docs/TEST_REPORT.md`へ記録
- [ ] 本番モードでは`device.mode=mock`が`allowMockInProduction`の値に関係なく拒否される
- [ ] 本番`screen`はMockとは別のアダプタで、外部通信・物理出力・故障注入APIを持たない
- [ ] 本番設定の`allowMockInProduction=false`
- [ ] `npm run deploy:prepare -- --config config/experiment.production.json`で自己完結リリースを新規生成した
- [ ] `VERIFY_RELEASE.cmd`がmanifest照合を含めて成功し、40文字`Source commit`を表示
- [ ] manifest schema version 4のappVersion、source tree SHA-256、対象設定SHA-256、GO証跡SHA-256、統合binding SHA-256が承認記録と一致
- [ ] manifest自身と全管理対象ファイルが通常ファイルかつhardlink数1である
- [ ] 生成時と`VERIFY_RELEASE.cmd`実行時の`Deployment manifest SHA-256`を照合者2名が独立に転記し、完全一致
- [ ] `START_PRODUCTION.cmd`の本番preflight成功
- [ ] production用`.cmd`が`%ProgramFiles%\nodejs\node.exe`だけを存在確認付きで使用し、bare `node`を実行しない
- [ ] `CHECK_HEALTH.cmd`が`NODE_OPTIONS`と`NODE_PATH`をclearし、appVersion、protocolVersion、config hash、deviceModeが一致
- [ ] リリース内にJSONL、CSV、`.env`、`src`、`tests`、Mock/E2E設定がない
- [ ] リリース内の`data/`が空で、過去セッションのログを含まない
- [ ] 設定変更後にリリースを再生成し、古いmanifestを手編集していない

## 状態・停止処理

- [ ] STOP、DEFLATEの順で停止処理を実行し、その後にScreenPufferDeviceの論理statusを確認する（USBコマンドではない）
- [ ] DEFLATE後に`idle`・level 0・faultなしを確認してから収縮完了と判定する
- [ ] 収縮完了を確認できない場合は成功扱いにせず、参加者画面を中立な中断画面へ移行する
- [ ] SIGINT、SIGTERM、SIGBREAK、未捕捉例外および未処理Promise拒否が共有shutdown処理へ入る
- [ ] shutdownが重複しても、同一の終了Promiseを共有して安全処理を重複実行しない
- [ ] 装置切断、アプリ停止、HTTP停止の一部が失敗しても残りのクリーンアップを継続する
- [ ] shutdown deadline内に停止処理が完了しない場合の中断・ログ確認手順を二名で確認した

## データ・ネットワーク

- [ ] `allowExternalRuntimeRequests=false`
- [ ] cloud/localのいずれの条件でも研究データを外部送信しない
- [ ] 外部CDN、外部フォント、分析、テレメトリへの通信がない
- [ ] Googleフォームをアプリが自動取得・自動送信しない
- [ ] リリースと`data/`がOneDrive等の同期対象外
- [ ] BitLocker等でローカルディスクを暗号化
- [ ] コード・設定は不用意に変更できないACL
- [ ] `data/`は実験用アカウントだけが書込み可能
- [ ] 隔離LANまたは単一PC構成
- [ ] LAN時は特定インターフェースとWindows Firewallを確認
- [ ] Operator tokenを写真・ログ・チャットへ保存していない
- [ ] ログに氏名、メール、IPアドレス、生体情報その他の禁止フィールドがない
- [ ] 正式リリースに`DATA_LIFECYCLE.cmd`、`dist-server/data-lifecycle.js`、変更用npm scriptが含まれない
- [ ] アプリ内の除外・削除APIが常にfail-closedで拒否される
- [ ] 承認済み外部手順とGoogleフォーム側の手動照合手順を研究責任者が確認した
- [ ] `data/`親、研究用ID registry、初期化anchorの独立バックアップと外部割付台帳を確認した
- [ ] 開発用保持期限レポートは候補を表示するだけで自動除外・自動削除しない

## 研究・フォーム

- [ ] 固定模擬データ方式が承認済み計画と一致
- [ ] 表示値が参加者本人の測定値ではなく、心拍等の生体データを取得しないことを研究説明・同意・導入で明示
- [ ] フグ条件が物理装置ではなく画面上の表現であることを明示
- [ ] 提示開始前の同意確認・記録方法を研究責任者が承認し、スタッフ手順と一致
- [ ] フォームとローカルログを同じ研究用IDで連結し、フォームへ提示順・順序コード・内部コードを入力させない承認済み手順がある
- [ ] `UI_COPY`と実画面を照合
- [ ] A/B右表示およびC/D右表示・装置動作の同一性を確認
- [ ] 参加者画面にA/B/C/Dの内部コードが表示されない
- [ ] Googleフォームの公開画面と公開payloadに内部コードA/B/C/Dおよび固定対応がない
- [ ] Googleフォームの提示数説明が4提示へ統一され、3種類という旧説明がない
- [ ] Googleフォームの回答手順が4提示・サマリー終了後の一括回答へ統一されている
- [ ] Googleフォームの研究説明、研究用ID 1件、実際に回答できる11評価グリッドだけを二名で照合
- [ ] 提示前同意を事後評価フォームとは別の承認済み経路で提示前に記録し、その経路を二名で照合
- [ ] 11評価質問が第1〜第4提示、承認済み7件法、任意回答で統一されている
- [ ] Googleフォームに無題の回答入力項目とファイルアップロード項目がない
- [ ] Googleフォームの研究用ID欄は厳密なラベル「研究用ID」の必須短文入力1件で、`^SH26-[0-9]{3}$`の完全一致validationがある
- [ ] Googleフォームに年齢・属性・同意等の追加回答項目がない
- [ ] `formUrl`が`https://forms.gle/BeShY7cY5zMjunto9`と完全一致
- [ ] `formAudit.status`が`GO`
- [ ] `formAudit.protocolVersion`と`formAudit.formUrl`が同じ本番設定の値と一言一句一致
- [ ] `npm run audit:form`が表示した安定した`FB_PUBLIC_LOAD_DATA_` payloadのSHA-256と`formAudit.contentSha256`が完全一致
- [ ] `formAudit.contentSha256`が既知のNO-GO公開payload SHA-256ではない
- [ ] `formAudit.auditedOn`が未来日ではなく、本番preflight実行日から7日以内
- [ ] `formAudit.twoPersonVerified=true`で、二名照合の氏名・日時はアプリ設定やログではなく承認済み管理場所へ記録
- [ ] QRとリンクの両方を二名で読み取り、同じ承認済みフォームを開く
- [ ] Google Forms管理画面と未ログイン実回答経路の両方で、メール収集が無効である
- [ ] Googleフォームで氏名・メール等を収集せず、Googleアカウントへのログインを要求しない
- [ ] `docs/FORM_AUDIT.md`の再監査記録へ確認者2名・日時・研究責任者承認を記録
- [ ] フォーム遷移は実験終了後の参加者による明示操作だけで行われる
- [ ] `goEvidence.researchPlan`、`ethicsDetermination`、`preStimulusConsent`、`dataManagementPlan`、`screenPilot`の文書ID・版・SHA-256・承認日・適用期限が外部承認記録と一致
- [ ] `screenPilot.completedSessions`は、Mock・公開レビュー・E2Eを除く承認済みscreenパイロット3〜5件である
- [ ] `screenPilot.sourceTreeSha256`が`releaseVerification.sourceTreeSha256`と一致し、`screenPilot.pilotConfigFileHash`が候補commitの固定pilot設定バイトSHA-256と一致する
- [ ] `goEvidence.releaseVerification`のappVersionとsource tree SHA-256が`npm run release:source-evidence`の値と一致する
- [ ] `goEvidence.releaseVerification.reviews`は異なる非個人識別review ID・reviewer codeを持ち、同じappVersion・source tree SHA-256・対象設定SHA-256を独立に照合している

## UI・画面確認

- [ ] 参加者向け固定文言、条件、提示順、タイミング、固定値が承認済み仕様と一致
- [ ] 装飾用eyebrow、同心円、軌道、浮遊点、英語の小見出しがなく、共通導入・フェーズ案内・結果・サマリーの主要内容が承認済みの中央基準レイアウトである
- [ ] 条件画面は左右2パネルで表示領域を使い、片側だけに大きな空白が残らない
- [ ] A/Bの結果表示が完全に同一
- [ ] C/Dの結果表示、画面上のフグのレベル・開始時刻・膨張・保持・収縮が完全に同一
- [ ] 1366×768と1920×1080の両方で、全画面がはみ出さない
- [ ] 全4提示順のスクリーンショット一式を二名で照合
- [ ] 中断・接続切れ・刺激異常画面が中立な文言で表示される

## screen実地試験

- 実験用Windows PC:
- 表示端末・ブラウザ:
- 実施場所:

- [ ] `R8-010-2x2-screen-v1`、screenモード、空のserialPathが一致
- [ ] 物理フグ、USBシリアル機器、心拍・生体センサが接続されていない
- [ ] ScreenPufferDeviceの論理ready/statusを確認し、`idle`・level 0・faultなし（USBのPING、STATUS、ACK確認ではない）
- [ ] 固定レベル0.6まで6秒膨張・結果提示終了までの保持・6秒収縮を確認
- [ ] DEFLATE後に`idle`・level 0・faultなしを確認
- [ ] 通常フェーズの途中リロードはOperator確認まで停止し、result/reset中のリロードはSTOP・DEFLATE・errorで再開不能になる
- [ ] STOP・DEFLATE・参加者画面切断・スタッフ画面切断で中立な中断状態へ移る
- [ ] スタッフ画面の1秒heartbeat／5秒leaseでLAN断・half-open・ブラウザ停止を検出し、最後のlease喪失ではSTOP・DEFLATE・`OPERATOR_CONNECTION_LOST`、複数接続の1つが生存中は継続する
- [ ] 停電・PC断後に未終端セッションを再開せず、監査ログを保持する
- [ ] 1366×768と1920×1080で表示欠けがなく、C/Dの画面刺激が同一

## 最終GO判定

- [ ] 本番GOブロッカーが0件
- [ ] `docs/TEST_REPORT.md`へ最終実測値を記録済み
- [ ] screen本番リリース・会場・フォームを含む当日構成でリハーサルを完走
- [ ] 二名の照合者と研究責任者が同じリリースmanifestを確認

最終判定: [ ] GO / [ ] NO-GO

- 照合者1・日時:
- 照合者2・日時:
- 研究責任者の最終承認・日時:
- NO-GOの場合の理由:

未記入または未チェックの必須項目が1つでもある場合、判定はNO-GOとします。
