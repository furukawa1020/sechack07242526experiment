# 本番技術リリースチェックリスト

対象プロトコル: `R8-010-2x2-screen-v3`

このチェックリストはソフトウェアの技術状態と当日の安全な開始条件を確認するものであり、倫理承認の証跡ではない。承認資料と実施条件の確認は本システム外で行う。本書、アプリ、設定、Git、CI、manifest、ログへ承認PDF、承認文書参照、承認文書のSHA-256、確認者情報、署名を記入・保存しない。

## 1. 状態の分離

- [ ] `technicalReadiness = GO`
- [ ] `participantMode = enabled`
- [ ] `complianceMode = external`
- [ ] `approvalEvidence = managed-outside-system`
- [ ] `approvalVerifiedByApplication = false`
- [ ] Operator表示が`技術状態：実施可能`
- [ ] Operator表示が`参加者モード：有効`
- [ ] Operator表示が`承認証跡：本システム外で管理`
- [ ] Operator表示が`本システムによる承認検証：実施しない`
- [ ] 「承認済み」「二名照合済み」「承認PDF確認済み」等をアプリが表示しない

旧`goEvidence`、承認文書、承認hash、二名照合、reviewer identity、screen pilot件数、manual GO ticketは正式release/startのハードゲートにしない。

## 2. リリース識別と技術的整合

次は成果物の再現性と改変検出に使う技術情報であり、承認証跡ではない。

- リリースディレクトリ名:
- 生成元Git commit:
- appVersion:
- protocolVersion:
- 生成日時:
- Windows版・architecture:
- Node.js版:
- 設定ファイル名:
- manifest検証結果:

- [ ] 検証対象commitと設定からビルドした
- [ ] manifestの管理対象ファイル、サイズ、技術的整合チェックがPASS
- [ ] manifestに承認資料、承認文書ハッシュ、確認者情報がない

## 3. 正式構成

- [ ] 会場のWindows PC 1台だけを使用する
- [ ] bind先は`127.0.0.1`だけで、LANや一般公開originへ公開しない
- [ ] `R8-010-2x2-screen-v3`
- [ ] `environment=production`
- [ ] `participantMode=enabled`
- [ ] `compliance.mode=external`
- [ ] `compliance.evidenceStorage=outside-system`
- [ ] `compliance.verifiedByApplication=false`
- [ ] `runtime.requireOperatorSessionConfirmation=true`
- [ ] `runtime.persistOperatorConfirmation=false`
- [ ] `runtime.requireConsentConfirmation=true`
- [ ] `runtime.requireEmergencyStopCheck=true`
- [ ] `device.mode=screen`
- [ ] `serialPath=""`
- [ ] `allowMockInProduction=false`
- [ ] `network.allowExternalRuntimeRequests=false`
- [ ] `formUrl=""`
- [ ] `formAudit`と`goEvidence`が正式設定に存在しない
- [ ] 物理フグ、USBシリアル、心拍その他の生体センサが接続されていない
- [ ] 外部CDN、外部フォント、分析、広告、テレメトリがない

## 4. 当日Operator確認と同意

- [ ] 起動後に「外部管理事項と当日運用の確認」が表示される
- [ ] 本日の実施手順、提示前同意、実験中止操作、必要時のSTOP・収縮を確認する4項目がある
- [ ] 氏名、メール、ID、署名、承認番号、承認文書、SHA-256を入力させない
- [ ] 確認状態をサーバメモリまたは`sessionStorage`だけに保持する
- [ ] 実験ログ、データベース、`localStorage`、manifestへ永続保存しない
- [ ] アプリまたはブラウザの再起動後に再確認を要求する
- [ ] Operatorセッション内確認前はprepare/startを拒否する
- [ ] 参加者ごとの提示前同意が未確認なら第1提示を開始できない
- [ ] 緊急停止は確認画面を含む全状態で利用可能

## 5. 外部回答分離

- [ ] 参加者UIに外部フォーム・外部調査の名称、URL、リンク、QRコードがない
- [ ] 参加者UIに回答方法・回答完了確認がない
- [ ] Operatorに外部回答内容・送信・完了確認がない
- [ ] アプリが外部回答を取得、表示、案内、送信、複製、完了確認しない
- [ ] 外部調査を使用する場合は研究スタッフがアプリ外で運用する
- [ ] 各提示後のチェックポイントを外部回答の内容、送信または完了確認として扱わない
- [ ] 回答チェックポイントAPIは`POST /api/sessions/:id/confirm-response-checkpoint`
- [ ] 完了操作は一般的なスタッフ引継ぎ確認
- [ ] 完了APIは`POST /api/sessions/:id/confirm-staff-handoff`

## 6. 正式成果物

- [ ] ビルド済みクライアント・サーバ、production依存関係、external compliance設定、manifest、必要な本番文書だけを含む
- [ ] 承認PDF、承認文書参照、承認文書ハッシュ、確認者情報、署名を含まない
- [ ] `FORM_*`を含まない
- [ ] `MOCK_REHEARSAL.md`、Mock用設定・起動経路を含まない
- [ ] `PUBLIC_DEMO.md`、公開レビュー用資材を含まない
- [ ] screen-pilot用設定・起動経路・ログを含まない
- [ ] ソース、テスト、E2E設定、スクリーンショットを含まない
- [ ] 実ログ、CSV、`.env`を含まない

## 7. ソフトウェア受入

- [ ] `npm run lint`成功
- [ ] `npm run typecheck`成功
- [ ] `npm test`成功
- [ ] `npm run test:e2e`成功
- [ ] `npm run build`成功
- [ ] external compliance設定は承認文書・承認hash・二人目の確認者なしで起動できる
- [ ] screen pilot件数0でも、それだけを理由にpreflight・release・startが失敗しない
- [ ] Operatorセッション内確認なしでは第1提示を開始できない
- [ ] 同意確認なしでは第1提示を開始できない
- [ ] Operator確認は再起動後に失われる
- [ ] 緊急停止が全状態で機能する
- [ ] 外部originへのruntime requestが0件
- [ ] ログに氏名、メール、IP、確認者情報、承認文書ハッシュがない

## 8. 研究条件とUI

- [ ] A = cloud + label
- [ ] B = local + label
- [ ] C = local + puffer
- [ ] D = cloud + puffer
- [ ] 提示順はABDC / BCAD / CDBA / DACB
- [ ] 固定値は72 / 高ストレス / pufferLevel 0.60
- [ ] 時間は8秒 / 3秒 / 15秒 / 7秒
- [ ] 参加者画面にA〜D、承認状態、Operator確認状態を表示しない
- [ ] A/Bの右側表示が完全に同一
- [ ] C/Dの右側表示と画面フグ動作が完全に同一
- [ ] 4提示それぞれの`reset`後に`response`で停止する
- [ ] 第1〜第3提示後は明示確認で次の`handling`、第4提示後は明示確認で`summary`へ進む
- [ ] クラウド条件でも外部送信しない
- [ ] 赤・緑、安全・危険、推奨・非推奨の価値判断がない
- [ ] 1366×768と1920×1080で欠け・不要なスクロールがない
- [ ] `response`は`第{n}提示は終了しました`／`研究スタッフの案内をお待ちください。`だけ
- [ ] サマリーは`4つの提示は終了しました`／`4つの提示は以上です。\n研究スタッフの案内をお待ちください。`

## 9. 現地runtime check

- [ ] `VERIFY_RELEASE.cmd`が技術的な成果物整合をPASS
- [ ] `START_PRODUCTION.cmd`がexternal compliance設定とpreflight検証後に起動
- [ ] `CHECK_HEALTH.cmd`がprotocolVersion、appVersion、config hash、`deviceMode=screen`を返す
- [ ] ScreenPufferDeviceは開始前に`idle`、level 0、faultなし
- [ ] 6秒で0.60まで膨張し、結果終了まで保持し、6秒で収縮
- [ ] STOP、DEFLATE後に`idle`、level 0
- [ ] 4提示それぞれの`response`でOperatorの明示確認まで停止
- [ ] 通常フェーズの再読み込みはOperator確認まで停止
- [ ] `result`/`reset`中の再読み込みはSTOP、DEFLATE、`error`となり再開不能
- [ ] 最後のOperator lease喪失はSTOP、DEFLATE、`OPERATOR_CONNECTION_LOST`

非参加者screen pilotは任意の品質確認である。実施する場合も実参加者、正式ID、外部回答を使用せず、未実施または件数0を開始拒否理由にしない。

## 10. 技術判定

```text
TECHNICAL RELEASE: GO / NO-GO
PARTICIPANT MODE: ENABLED / DISABLED
COMPLIANCE MODE: EXTERNAL
APPROVAL EVIDENCE: MANAGED OUTSIDE SYSTEM
APPROVAL VERIFIED BY APPLICATION: NO
```

技術判定`GO`は倫理承認をアプリが確認したという意味ではない。開始時のセッション内確認、参加者ごとの同意、緊急停止、必須runtime checkのいずれかが欠ける場合は第1提示を開始しない。
