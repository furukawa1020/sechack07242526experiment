# 本番リリース二名照合票

この票はアプリへ入力せず、研究計画で承認された管理方法で保管します。実参加者の氏名・回答・生体情報は記入しません。

> **現時点の判定はNO-GOです。** [Googleフォーム公開内容監査](FORM_AUDIT.md)に未解決所見があり、実機のWindows COMポートとUSBシリアル実地試験も未完了です。下記の「本番GOブロッカー」がすべて解消されるまで実参加者へ提示してはなりません。

Googleフォームは、実運用設定の`formUrl`に次のURLが設定される前提です。

`https://forms.gle/BeShY7cY5zMjunto9`

## 本番GOブロッカー

- [ ] `docs/FORM_AUDIT.md`の未解決所見が0件となり、修正後のフォームを二名で再監査した
- [ ] 本番設定の`formAudit`が全機械ゲートを満たし、本番preflightとproductionサーバ起動が成功した
- [ ] 実機を接続したWindows PCでCOMポート番号を確定し、設定値と一致させた
- [ ] USBシリアル接続、膨張、保持、収縮、停止および異常系を実地で完走した
- [x] 単一インスタンスロックをサーバ起動へ統合し、二重起動拒否とstale lock回復をテストした
- [x] 最終の全コマンド実行結果、テスト件数およびカバレッジを`docs/TEST_REPORT.md`へ確定値で記録した
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
- リリースmanifest SHA-256:

## 実機なし事前確認（本番GO判定外）

公開デモの自動リハーサルは、ページメモリ内だけで4提示と画面上のフグ動作を固定時間どおりに再現する。研究用ID、同意、フォーム、ログ、API、WebSocket、装置アダプタ、実機命令は使用しない。`npm run test:public-demo`で1366×768、1920×1080、390×844、320×568、844×390の5画面幅を20テスト・skipなしで確認する。

ローカルの密封Mockリハーサルは、`npm run rehearsal`またはクリーンな作業ツリーから生成した`sechack-mock-rehearsal-*`の`START_MOCK_DEMO.cmd`を使用する。loopback、MockDevice、空のフォームURL、`data/mock-sessions/`への分離ログ、`DEMO-001`形式の模擬IDだけを使用する。公開自動リハーサルと密封Mockリハーサルのどちらも、本番参加、同意確認、フォーム受入、COM確定、USBシリアル実機安全試験の代替にしてはならない。

## ソフトウェア受入

- [ ] `npm run lint`成功
- [ ] `npm run typecheck`成功
- [ ] `npm test`成功。最終件数を`docs/TEST_REPORT.md`へ記録
- [ ] `npm run test:e2e`成功。現在定義されている9ケースをすべて完走し、最終件数を`docs/TEST_REPORT.md`へ記録
- [ ] `npm run test:public-demo`成功。5画面幅・20ケースをskipなしで完走し、外部能動通信がない
- [ ] `npm run build`成功
- [ ] リリース生成直前の`git status --short`が空で、追跡・未追跡の変更がない
- [ ] `git rev-parse HEAD`の40文字commitとmanifestの`sourceCommit`が一致
- [ ] manifestの`sourceRepository`に認証情報がなく、承認済みrepositoryと一致（フィールドがある場合）
- [ ] 条件マッピング、順序割付、ステートマシン、装置アダプタ、ログ許可フィールドの最終カバレッジを`docs/TEST_REPORT.md`へ記録
- [ ] 本番モードでは`device.mode=mock`が`allowMockInProduction`の値に関係なく拒否される
- [ ] 本番設定の`allowMockInProduction=false`
- [ ] `npm run deploy:prepare`で自己完結リリースを新規生成した
- [ ] `VERIFY_RELEASE.cmd`がmanifest照合を含めて成功し、40文字`Source commit`を表示
- [ ] 生成時と`VERIFY_RELEASE.cmd`実行時の`Deployment manifest SHA-256`を照合者2名が独立に転記し、完全一致
- [ ] `START_PRODUCTION.cmd`の本番preflight成功
- [ ] `CHECK_HEALTH.cmd`のappVersion、protocolVersion、config hash、deviceMode一致
- [ ] リリース内にJSONL、CSV、`.env`、`src`、`tests`、Mock/E2E設定がない
- [ ] リリース内の`data/`が空で、過去セッションのログを含まない
- [ ] 設定またはCOMポート変更後にリリースを再生成し、古いmanifestを手編集していない

## 状態・停止処理

- [ ] STOP、DEFLATE、STATUSの順で停止処理を実行する
- [ ] DEFLATE後に`idle`・level 0・faultなしを確認してから収縮完了と判定する
- [ ] 収縮完了を確認できない場合は成功扱いにせず、参加者画面を中立な中断画面へ移行する
- [ ] SIGINT、SIGTERM、SIGBREAK、未捕捉例外および未処理Promise拒否が共有shutdown処理へ入る
- [ ] shutdownが重複しても、同一の終了Promiseを共有して安全処理を重複実行しない
- [ ] 装置切断、アプリ停止、HTTP停止の一部が失敗しても残りのクリーンアップを継続する
- [ ] shutdown deadline内に停止処理が完了しない場合の物理緊急停止手順を二名で確認した

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

## 研究・フォーム

- [ ] 固定模擬データ方式が承認済み計画と一致
- [ ] `UI_COPY`と実画面を照合
- [ ] A/B右表示およびC/D右表示・装置動作の同一性を確認
- [ ] 参加者画面にA/B/C/Dの内部コードが表示されない
- [ ] Googleフォームの公開画面と公開payloadに内部コードA/B/C/Dおよび固定対応がない
- [ ] Googleフォームの提示数説明が4提示へ統一され、3種類という旧説明がない
- [ ] Googleフォームの回答手順が4提示・サマリー終了後の一括回答へ統一されている
- [ ] Googleフォームの研究説明・同意・実際に回答できる11問を二名で照合
- [ ] `formUrl`が`https://forms.gle/BeShY7cY5zMjunto9`と完全一致
- [ ] `formAudit.status`が`GO`
- [ ] `formAudit.protocolVersion`と`formAudit.formUrl`が同じ本番設定の値と一言一句一致
- [ ] `npm run audit:form`が表示した安定した`FB_PUBLIC_LOAD_DATA_` payloadのSHA-256と`formAudit.contentSha256`が完全一致
- [ ] `formAudit.auditedOn`が未来日ではなく、本番preflight実行日から7日以内
- [ ] `formAudit.twoPersonVerified=true`で、二名照合の氏名・日時はアプリ設定やログではなく承認済み管理場所へ記録
- [ ] QRとリンクの両方を二名で読み取り、同じ承認済みフォームを開く
- [ ] Google Forms管理画面と未ログイン実回答経路の両方で、メール収集が無効である
- [ ] Googleフォームで氏名・メール等を収集せず、Googleアカウントへのログインを要求しない
- [ ] `docs/FORM_AUDIT.md`の再監査記録へ確認者2名・日時・研究責任者承認を記録
- [ ] フォーム遷移は実験終了後の参加者による明示操作だけで行われる

## UI・画面確認

- [ ] 参加者向け固定文言、条件、提示順、タイミング、固定値が承認済み仕様と一致
- [ ] 装飾用eyebrow、同心円、軌道、浮遊点、英語の小見出しがなく、共通導入・フェーズ案内・結果・サマリーの主要内容が承認済みの中央基準レイアウトである
- [ ] 条件画面は左右2パネルで表示領域を使い、片側だけに大きな空白が残らない
- [ ] A/Bの結果表示が完全に同一
- [ ] C/Dの結果表示と装置命令が完全に同一
- [ ] 1366×768と1920×1080の両方で、全画面がはみ出さない
- [ ] 全4提示順のスクリーンショット一式を二名で照合
- [ ] 中断・接続切れ・装置異常画面が中立な文言で表示される

## 実機・実地試験

- 実機名・管理番号:
- 確定COMポート:
- 実験用Windows PC:
- 実施場所:

- [ ] Serialモードと確定COMポートが一致
- [ ] PING・STATUS成功
- [ ] 最大上限と物理緊急停止を確認
- [ ] 6秒膨張・結果提示終了までの保持・6秒収縮を確認
- [ ] DEFLATE後に`idle`・level 0・faultなしを確認
- [ ] ACK遅延・ACK timeout・USB切断・faultで安全停止
- [ ] ブラウザ途中リロードと再接続後も、サーバ状態へ正しく同期
- [ ] 停電・PC断で実機単体の排気が動作
- [ ] 空気漏れ・異音・異臭・過熱なし
- [ ] STOP、物理緊急停止、USB抜去および電源遮断の担当と手順を実地で確認

## 最終GO判定

- [ ] 本番GOブロッカーが0件
- [x] `docs/TEST_REPORT.md`へ最終実測値を記録済み
- [ ] 実機・会場・フォームを含む当日構成でリハーサルを完走
- [ ] 二名の照合者と研究責任者が同じリリースmanifestを確認

最終判定: [ ] GO / [ ] NO-GO

- 照合者1・日時:
- 照合者2・日時:
- 研究責任者の最終承認・日時:
- NO-GOの場合の理由:

未記入または未チェックの必須項目が1つでもある場合、判定はNO-GOとします。
