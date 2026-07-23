# SecHack365 実験提示サイト

参加者本人を測定したものではない同一の固定模擬データを、4条件で提示する人対象研究向けローカルWebアプリです。正式MVPは `R8-010-2x2-screen-v3` です。

正式運用は会場のWindows PC 1台だけで行い、サーバと全画面表示を `127.0.0.1` 上で動かします。USB機器、物理フグ、心拍その他の生体センサは使用しません。画面内のフグは `ScreenPufferDevice` がサーバ時刻に同期して描画します。

正式productionは **EXTERNAL COMPLIANCE MODE** です。倫理承認資料の確認と証跡管理は研究責任者および当日の運用責任者が本システム外で行います。本アプリは承認PDF、文書参照、承認文書のSHA-256、確認者情報、署名を要求・保存・検証せず、「承認済み」とも表示しません。

アプリ内の状態は次のように責務を分けます。

```text
technicalReadiness = GO
participantMode = enabled
complianceMode = external
approvalEvidence = managed-outside-system
approvalVerifiedByApplication = false
```

第1提示の開始には、当日のOperatorセッション内確認、参加者ごとの提示前同意確認、緊急停止の利用可能性、必須runtime check成功が必要です。これらの安全ゲートは維持します。

## v3の外部回答境界

参加者画面と正式リリース成果物には、外部回答に関する名称、導線、回答方法、回答完了確認を含めません。アプリは外部回答を取得、表示、案内、送信、複製、完了確認しません。

外部調査を別途使用する場合は、研究スタッフがアプリ外で案内・運用します。提示前の研究説明と同意もアプリ外で取得・記録し、Operatorは参加者ごとに完了を確認します。確認結果そのものや参加者情報はアプリへ複製しません。

各提示のリセット後は、参加者画面を中立な待機表示へ置き換え、自動進行を停止します。Operatorが参加者への案内を確認して明示操作した場合だけ、第1〜第3提示後は次の提示、第4提示後はサマリーへ進みます。アプリは外部回答の内容、送信または完了を確認しません。

4提示後のサマリーは次の文言だけを表示します。

```text
4つの提示は終了しました

4つの提示は以上です。
研究スタッフの案内をお待ちください。
```

Operatorは外部回答の有無を扱わず、一般的なスタッフ引継ぎだけを確認します。対応APIは `POST /api/sessions/:id/confirm-staff-handoff` です。

## 研究条件

- A = cloud + label
- B = local + label
- C = local + puffer
- D = cloud + puffer
- 提示順 = ABDC / BCAD / CDBA / DACB
- 固定値 = 72 / 高ストレス / pufferLevel 0.60
- 提示時間 = 8秒 / 3秒 / 15秒 / 7秒
- 画面フグ = 6秒膨張 / 結果終了まで保持 / 6秒収縮

参加者画面にA〜Dは表示しません。A/Bの右側表示は完全に同一、C/Dの右側表示とフグ動作は完全に同一です。「クラウド」は比較用シナリオであり、クラウド条件でも外部送信しません。クラウドと端末内は、同じ色・線幅・占有領域の中立な線画と日本語ラベルで識別し、赤・緑、安全・危険、推奨・非推奨の価値判断を付けません。

## 画面

- `/operator`: 研究スタッフ用
- `/display/:token`: 参加者用の読取り専用画面
- `/device-test`: 画面上フグの状態・STOP・DEFLATE確認
- `/healthz`: ローカルサーバの稼働確認

サーバを唯一の状態源とし、クライアント固有タイマーだけでは進行しません。参加者画面の切断、Operator lease喪失、刺激異常、不正遷移では、STOP、DEFLATE、中断を優先します。

## 開発と検証

依存関係を導入した後、次を実行します。

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

開発、E2E、模擬リハーサル、screenパイロットは非参加者専用です。参加者側とOperatorへ、次の非参加者表示を常設します。

```text
研究参加用ではありません・外部回答送信なし
```

開発用Mockは `npm run dev`、明示的な模擬リハーサルは `npm run rehearsal`、任意の非参加者screen品質確認は `npm run screen-pilot` を使用します。screen pilotは品質確認用であり、件数や実施有無を正式リリース・起動のハードゲートにしません。

## 正式リリース

正式production設定は次を固定します。

```json
{
  "environment": "production",
  "participantMode": "enabled",
  "protocolVersion": "R8-010-2x2-screen-v3",
  "bindHost": "127.0.0.1",
  "compliance": {
    "mode": "external",
    "evidenceStorage": "outside-system",
    "verifiedByApplication": false
  },
  "runtime": {
    "requireOperatorSessionConfirmation": true,
    "persistOperatorConfirmation": false,
    "requireConsentConfirmation": true,
    "requireEmergencyStopCheck": true
  },
  "network": {
    "allowLan": false,
    "allowExternalRuntimeRequests": false
  },
  "formUrl": "",
  "device": {
    "mode": "screen",
    "serialPath": "",
    "allowMockInProduction": false
  }
}
```

`formAudit` は設定へ含めません。screen-v1用のフォーム監査はv3のリリースゲートでも起動ゲートでもありません。

本番成果物は、クリーンな検証対象commitとexternal compliance設定から次で生成します。

```powershell
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

正式成果物はビルド済みアプリ、production依存関係、external compliance設定、manifest、必要な運用文書だけを含みます。承認資料、承認文書ハッシュ、確認者情報は含めません。次も正式成果物へ同梱しません。

- `FORM_*`
- `MOCK_REHEARSAL.md` とMock用設定・起動経路
- `PUBLIC_DEMO.md` と公開レビュー用資材
- screen-pilot用設定・起動経路・ログ
- ソース、テスト、スクリーンショット、実ログ

会場PCでは同梱の `VERIFY_RELEASE.cmd` で技術的な成果物整合を確認した後、`START_PRODUCTION.cmd` で起動します。表示先は同じPCの `http://127.0.0.1:4173/operator` です。一般公開URLやHugging Face上の静的レビュー版は表示確認専用であり、正式productionではありません。

詳しい手順は [Windowsローカル本番デプロイ](docs/DEPLOYMENT.md)、[実験運用手順](docs/RUNBOOK.md)、[本番技術リリースチェックリスト](docs/RELEASE_CHECKLIST.md)を参照してください。

## データ保護

- 氏名、メール、学籍番号、IP、User-Agent全文、位置情報、カメラ、マイク、ブラウザ指紋、生体データを収集・記録しない
- 固定模擬データ、ローカルログ、研究用IDを外部へ送信しない
- 外部CDN、外部フォント、分析、広告、テレメトリを使用しない
- 実ログをGit、公開成果物、チャット、issue、テストへ含めない
- 外部調査の回答をアプリへ取得・複製しない
- 撤回・除外・削除はサーバ停止後、研究責任者が承認した外部手順へ引き渡す

詳細は [研究データの撤回・除外・保持期限手順](docs/DATA_LIFECYCLE.md)を参照してください。

## 必読文書

- [実験仕様](docs/EXPERIMENT_SPEC.md)
- [参加者向け固定文言](docs/UI_COPY.md)
- [装置境界仕様](docs/DEVICE_PROTOCOL.md)
- [EXTERNAL COMPLIANCE MODEの境界](docs/GO_EVIDENCE.md)
- [プロトコル変更履歴](docs/PROTOCOL_CHANGELOG.md)
- [テスト報告](docs/TEST_REPORT.md)

`docs/FORM_*` はscreen-v1の監査履歴またはアプリ外で任意の外部調査を運用するときの参考資料です。screen-v3の正式成果物には同梱せず、本番リリース・起動条件として扱いません。

承認資料と実施条件の確認は本システム外で行います。本アプリでは、参加者モード、当日のOperatorセッション内確認、参加者ごとの提示前同意、緊急停止、必須runtime checkだけを開始条件として検証します。
