# 本番リリース二名照合票

対象プロトコル: `R8-010-2x2-screen-v2`

この票はアプリへ入力せず、承認済みの外部管理方法で保管する。参加者の氏名、回答、生体情報は記入しない。

未記入または未確認の必須項目が一つでもあれば**NO-GO**とする。

## 1. 本番GOブロッカー

次の6件が、同じprotocolVersion、appVersion、対象設定SHA-256、source tree SHA-256へ結び付いた有効な`goEvidence`であること。

- [ ] 承認済み研究計画
- [ ] 承認済み倫理判断
- [ ] 提示前同意の承認済み取得・記録手順
- [ ] 承認済みデータ管理計画
- [ ] 研究チームの非参加者によるscreenパイロット3〜5件
- [ ] 独立二名照合

screen-v1の外部回答監査はv2の本番リリース・起動ゲートではない。

## 2. リリース識別

- リリースディレクトリ名:
- 生成元Git commit（40文字）:
- 生成元repository（manifestに記録された場合）:
- appVersion:
- protocolVersion:
- 生成日時:
- Windows版・architecture:
- Node.js版:
- 設定ファイル名:
- 設定ファイルSHA-256:
- 設定内容SHA-256:
- 対象設定SHA-256（`criticalConfigSha256`）:
- GO証跡SHA-256:
- HEAD追跡source tree SHA-256（production設定だけを除外）:
- source／appVersion／設定／証跡binding SHA-256:
- リリースmanifest SHA-256:

## 3. 正式構成

- [ ] 会場のWindows PC 1台だけを使用する
- [ ] bind先は`127.0.0.1`だけで、LANや一般公開originへ公開しない
- [ ] `R8-010-2x2-screen-v2`である
- [ ] `device.mode=screen`
- [ ] `serialPath=""`
- [ ] `allowMockInProduction=false`
- [ ] `network.allowExternalRuntimeRequests=false`
- [ ] `formUrl=""`
- [ ] `formAudit`が存在しない
- [ ] 物理フグ、USBシリアル、心拍その他の生体センサが接続されていない
- [ ] 外部CDN、外部フォント、分析、広告、テレメトリがない

## 4. 外部回答分離

- [ ] 参加者UIに外部フォーム・外部調査の名称がない
- [ ] 参加者UIに外部回答導線がない
- [ ] 参加者UIに回答方法・回答完了確認がない
- [ ] Operatorに外部回答情報・完了確認がない
- [ ] アプリが外部回答を取得、表示、案内、送信、複製、完了確認しない
- [ ] 外部調査を使用する場合は、研究スタッフがアプリ外の承認済み手順で運用する
- [ ] Operator完了操作は一般的なスタッフ引継ぎ確認である
- [ ] 完了APIは`POST /api/sessions/:id/confirm-staff-handoff`である

## 5. 正式成果物の内容

- [ ] ビルド済みクライアント・サーバ、production依存関係、承認済み設定、manifest、必要な本番文書だけを含む
- [ ] `FORM_*`を含まない
- [ ] `MOCK_REHEARSAL.md`、Mock用設定・起動経路を含まない
- [ ] `PUBLIC_DEMO.md`、公開レビュー用資材を含まない
- [ ] screen-pilot用設定・起動経路・ログを含まない
- [ ] ソース、テスト、E2E設定、スクリーンショットを含まない
- [ ] 実ログ、CSV、`.env`を含まない
- [ ] 全管理対象ファイルがmanifestのサイズ・SHA-256と一致する
- [ ] 通常ファイル・単一hardlinkだけで構成される

## 6. ソフトウェア受入

- [ ] `npm run lint`成功
- [ ] `npm run typecheck`成功
- [ ] `npm test`成功。最終件数を`docs/TEST_REPORT.md`へ記録
- [ ] `npm run test:e2e`成功。全ケースskipなし
- [ ] `npm run build`成功
- [ ] 条件対応・順序割付100%
- [ ] ステートマシン90%以上
- [ ] ScreenPufferDevice、MockPufferDevice、SerialPufferDevice境界90%以上
- [ ] ログ許可フィールド100%
- [ ] 外部originへのruntime requestが0件
- [ ] 参加者payloadへ研究用ID、提示順、A〜D、pufferLevelを出さない
- [ ] 重複研究用ID、不正遷移、切断、緊急停止をフェイルクローズで拒否する
- [ ] production CLIは封印済みmanifest経由だけで起動できる
- [ ] 直接production起動、設定差し替え、環境変数上書きを拒否する
- [ ] build lock、単一server lock、stale lock回復を確認した

## 7. 研究条件

- [ ] A = cloud + label
- [ ] B = local + label
- [ ] C = local + puffer
- [ ] D = cloud + puffer
- [ ] 提示順はABDC / BCAD / CDBA / DACB
- [ ] 固定値は72 / 高ストレス / pufferLevel 0.60
- [ ] 時間は8秒 / 3秒 / 15秒 / 7秒
- [ ] 参加者画面にA〜Dを表示しない
- [ ] A/Bの右側表示が完全に同一
- [ ] C/Dの右側表示と画面フグ動作が完全に同一
- [ ] クラウド条件でも外部送信しない
- [ ] クラウドと端末内を中立な同一色・線幅・占有領域で表す
- [ ] 赤・緑、安全・危険、推奨・非推奨の価値判断がない

## 8. UI・固定文言

- [ ] 日本語中心で、装飾用英語eyebrow、同心円、軌道、浮遊点がない
- [ ] 共通導入、フェーズ案内、結果、サマリーは中央基準
- [ ] 条件画面は左右2パネルで表示領域を使う
- [ ] 1366×768と1920×1080で欠け・不要なスクロールがない
- [ ] 全結果画面に `この表示は医療上の診断ではありません。` がある
- [ ] 共通導入とフッターに比較用シナリオであることを明示する
- [ ] サマリー見出しは `4つの提示は終了しました`
- [ ] サマリー本文1行目は `4つの提示は以上です。`
- [ ] サマリー本文2行目は `研究スタッフの案内をお待ちください。`
- [ ] サマリーに上記以外の外部回答導線がない
- [ ] 中断・接続切れ・刺激異常画面は中立な文言である

## 9. screen実地試験

- 実験用Windows PC:
- ブラウザ:
- 実施場所:

- [ ] 同じPCの`127.0.0.1`でOperatorと参加者画面を開いた
- [ ] `VERIFY_RELEASE.cmd`がPASSした
- [ ] `START_PRODUCTION.cmd`がmanifestとpreflight検証後に起動した
- [ ] `CHECK_HEALTH.cmd`がprotocolVersion、appVersion、config hash、`deviceMode=screen`を返した
- [ ] ScreenPufferDeviceは開始前に`idle`、level 0、faultなし
- [ ] 6秒で0.60まで膨張し、結果終了まで保持し、6秒で収縮した
- [ ] STOP、DEFLATE後に`idle`、level 0へ戻った
- [ ] 通常フェーズの再読み込みはOperator確認まで停止した
- [ ] `result`/`reset`中の再読み込みはSTOP、DEFLATE、`error`となり再開不能だった
- [ ] 最後のOperator lease喪失はSTOP、DEFLATE、`OPERATOR_CONNECTION_LOST`となった
- [ ] 停電・PC断後に未終端セッションを再開せず、監査ログを保持した

## 10. screenパイロット証跡

- パイロット管理票ID:
- 実施件数:
- source commit:
- source tree SHA-256:
- pilot設定バイトSHA-256:
- 管理票SHA-256:

- [ ] 研究チームの非参加者だけで3〜5件を実施した
- [ ] 異なる`PILOT-xxx`を使用した
- [ ] `研究参加用ではありません・外部回答送信なし`を常設した
- [ ] 実参加者、正式ID、外部回答を使用しなかった
- [ ] 候補リリースのsource evidenceと一致した

## 11. データ保護

- [ ] 氏名、メール、学籍番号、IP、User-Agent全文、位置情報、生体データを収集・記録しない
- [ ] 外部回答を取得・複製しない
- [ ] 実ログはGit・クラウド同期対象外
- [ ] 研究用ID registryと初期化anchorを独立に保全する
- [ ] 撤回、分析除外、削除はサーバ停止後の承認済み外部手順だけで行う
- [ ] 不可逆な変更機能を正式成果物へ含めない

## 12. 独立二名照合

- [ ] 照合者1と2は別々にmanifest SHA-256、source commit、appVersion、設定SHA-256、goEvidence SHA-256を転記した
- [ ] 一方の画面や転記をもう一方が写していない
- [ ] 2件の照合記録は異なる非個人識別review IDを持つ
- [ ] 研究責任者が同じリリースmanifestを最終承認した

## 13. 最終判定

最終判定: [ ] GO / [ ] NO-GO

- 照合者1・日時:
- 照合者2・日時:
- 研究責任者の最終承認・日時:
- NO-GOの場合の理由:

未記入または未確認の必須項目が一つでもある場合、判定はNO-GOとする。
