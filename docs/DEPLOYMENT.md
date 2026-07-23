# Windowsローカル本番デプロイ

対象プロトコル: `R8-010-2x2-screen-v3`

## 1. 正式構成

正式productionは、会場のWindows PC 1台へ配置するローカルWebアプリである。

- bind先は `127.0.0.1` のみ
- Operator、参加者表示、`/device-test`、`/healthz`は同じPCから開く
- USBシリアル、物理フグ、空圧装置、心拍その他の生体センサは接続しない
- `device.mode=screen`を使用し、`serialPath`は空、`allowMockInProduction=false`
- `network.allowExternalRuntimeRequests=false`
- 固定模擬データ、研究用ID、ログを外部送信しない
- 外部CDN、外部フォント、分析、広告、テレメトリを使用しない

一般公開WebサーバやHugging Face上の静的レビュー版は正式productionではない。公開レビュー版を本番実験、研究参加、同意、データ収集、ローカル同期試験へ転用しない。

## 2. 外部回答との分離

参加者画面と正式成果物は、外部回答に関する名称、導線、回答方法、回答完了確認を持たない。アプリは外部回答を取得、表示、案内、送信、複製、完了確認しない。

外部調査を使用する場合は、研究スタッフが本システム外の手順で案内・運用する。提示前同意もアプリ外で取得・記録する。アプリ内のセッション完了は外部回答完了を意味しない。

各提示の`reset`完了後は`response`で自動進行を停止し、参加者画面を`第{n}提示は終了しました`／`研究スタッフの案内をお待ちください。`だけの中立な待機表示へ置き換える。Operatorの`POST /api/sessions/:id/confirm-response-checkpoint`だけで、第1〜第3提示後は次の提示、第4提示後はサマリーへ進む。この確認は外部回答の内容、送信または完了確認ではない。

4提示後のサマリーは次の固定文言だけを表示する。

```text
4つの提示は終了しました

4つの提示は以上です。
研究スタッフの案内をお待ちください。
```

Operatorは一般的なスタッフ引継ぎだけを確認し、`POST /api/sessions/:id/confirm-staff-handoff`でセッションを完了する。

## 3. EXTERNAL COMPLIANCE MODEと開始条件

正式productionは`compliance.mode=external`を使用する。倫理承認の確認と証跡管理は研究責任者および当日の運用責任者が本システム外で行う。本アプリは承認PDF、承認文書参照、承認文書のSHA-256、確認者情報、署名を要求・保存・検証せず、承認済みとも表示しない。

技術状態は次の意味へ分ける。

```text
technicalReadiness = GO
participantMode = enabled
complianceMode = external
approvalEvidence = managed-outside-system
approvalVerifiedByApplication = false
```

旧`goEvidence`、承認文書、承認hash、二名照合、reviewer identity、screen pilot件数、manual GO ticketはrelease/startのハードゲートに含めない。screen-v1の外部回答監査もscreen-v3のリリースゲート・起動ゲートではない。本番設定は`formUrl=""`とし、`formAudit`を含めない。

第1提示の開始には、次をすべて満たす。

- `participantMode=enabled`
- 当日のOperatorセッション内確認済み
- 参加者ごとの提示前同意確認済み
- 緊急停止が利用可能
- 必須runtime checkが成功

Operator確認は氏名、メール、ID、署名、承認番号、承認文書、SHA-256を入力させず、サーバメモリまたは`sessionStorage`だけに保持する。アプリまたはブラウザ再起動後は再確認を要求する。

## 4. 本番設定

`config/experiment.production.example.json`から承認対象の`config/experiment.production.json`を作成する。参加者向け文言、条件、順序、固定値、時間、画面フグ動作を変える場合は、先にprotocolVersionと`PROTOCOL_CHANGELOG.md`を更新する。

重要な固定境界は次のとおり。

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

`formAudit`と`goEvidence`は含めない。[EXTERNAL COMPLIANCE MODEの責務境界](GO_EVIDENCE.md)に従い、承認資料・承認文書ハッシュ・確認者情報を設定へ記録しない。

## 5. 任意の非参加者screen品質確認

screen pilotは任意の品質確認であり、件数や実施有無を正式release/startの条件にしない。実施する場合は研究チームの非参加者だけが`PILOT-xxx`を使用する。

```powershell
npm.cmd run screen-pilot
```

次を確認する。

- 正式固定値、4順序、提示時間、4回の`response`停止・明示確認、ScreenPufferDevice動作
- 1366×768と1920×1080での可読性、中央配置、表示欠けなし
- Operatorに `非参加者用の事前確認` と `画面版・PILOT/テスト`、参加者側に `非参加者用の事前確認` と `外部回答送信なし` が常設される
- 外部回答導線が表示されない
- 切断、中止、STOP、DEFLATEが安全側へ遷移する
- 必要に応じてsource commit、source tree SHA-256、pilot設定バイトSHA-256を技術的な再現性確認に使用する。これらを倫理承認証跡として扱わない

パイロットは実参加者、正式`SH26-xxx`、外部回答を使用しない。正式成果物へscreen-pilotの設定、起動経路、ログを同梱しない。

## 6. 封印済みリリースの生成

クリーンな検証対象commitで、必要な5コマンドを実行する。

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

必要に応じて技術的なsource integrityを診断し、続けてリリースを生成する。`release:source-integrity`は任意の改変検出・再現性診断であり、倫理承認証跡の作成・検証やrelease/startの必須条件ではない。

```powershell
npm.cmd run release:source-integrity
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

リリース生成は、固定production設定の追跡・HEADバイト一致、appVersion、source commit、追跡source treeの技術的整合、external compliance設定、共有build lockを検証する。承認資料、承認文書ハッシュ、確認者情報、screen pilot件数は検証しない。失敗を回避するための直接起動、設定差し替え、既存build成果物の流用、環境変数上書きを行わない。

正式成果物へ含めるもの:

- ビルド済みクライアントとサーバ
- production依存関係
- external compliance設定1ファイル
- manifest検証、preflight、healthcheck
- 本番に必要な実験仕様、固定文言、装置境界、RUNBOOK、external compliance境界、データ管理文書
- `DEPLOYMENT_MANIFEST.json`
- Windows用の検証・起動・healthcheckランチャー

正式成果物から除外するもの:

- `FORM_*`
- `MOCK_REHEARSAL.md`とMock用設定・起動経路
- `PUBLIC_DEMO.md`と公開レビュー用資材
- screen-pilot用設定・起動経路・ログ
- ソース、テスト、E2E設定、スクリーンショット
- 実ログ、CSV、`.env`

既存の成果物を上書きせず、変更時は新しいリリースを生成する。

## 7. 会場PCへの配置

1. リリースディレクトリ全体を、Git・クラウド同期対象外のローカルディスクへコピーする。
2. manifest記載と同じNode.js版とWindows architectureを用意する。
3. 会場PCでは`npm install`、`npm ci`、buildを行わない。
4. `VERIFY_RELEASE.cmd`を実行し、全ファイルとmanifestの技術的整合、source commit、appVersion、external compliance設定がPASSすることを確認する。技術的ファイル整合のSHA-256は承認文書のSHA-256ではない。
5. `data/`だけが実行時書込み領域であり、空き容量とアクセス権が適切であることを確認する。
6. 同じ`data/`を使うサーバが起動していないことを確認する。二重起動拒否を別ポートや直接起動で回避しない。

## 8. 起動

1. 不要なクラウド同期、通知、スリープ、ブラウザ拡張を停止する。
2. 物理フグ、USBシリアル、生体センサが未接続であることを確認する。
3. `START_PRODUCTION.cmd`を実行する。
4. `CHECK_HEALTH.cmd`が`R8-010-2x2-screen-v3`、`deviceMode=screen`、検証対象の技術設定hashを返すことを確認する。
5. 同じPCで `http://127.0.0.1:4173/operator` と `/device-test` を開く。
6. ScreenPufferDeviceが`idle`、level 0、faultなしであることを確認する。
7. 6秒膨張、保持、6秒収縮、STOP、DEFLATEを確認する。
8. 参加者画面を同じPCの運用対象Chromiumで全画面表示し、1366×768または1920×1080で欠けがないことを確認する。
9. Operator画面で「外部管理事項と当日運用の確認」を完了する。氏名、ID、署名、承認資料を入力せず、アプリまたはブラウザ再起動後に再確認されることを確認する。

production起動後に模擬IDの練習セッションを作らない。一般公開URLへ誘導しない。会場ネットワークや別端末へbindしない。

## 9. 停止とログ回収

通常終了はサーバ端末でCtrl+Cを1回押す。STOP、DEFLATE、`idle`、level 0、ポート閉鎖を確認する。端末ウィンドウを先に閉じたり、強制終了したりしない。

実ログはリリース内の`data/sessions/YYYY-MM-DD/`だけに保存する。終了後、件数、研究用ID、終了状態を確認し、承認済み暗号化保存先へ移す。Git、チャット、issue、テスト、再配布物へ含めない。

撤回、分析除外、削除はサーバ停止後、[研究データの撤回・除外・保持期限手順](DATA_LIFECYCLE.md)に従い、研究責任者が承認した外部手順へ引き渡す。アプリ内で不可逆な変更を行わない。

## 10. 将来の物理フグ版

`device.mode=serial`、USBシリアル、空圧、物理緊急停止を使う版はscreen-v3に含めない。実施する場合は、別protocolVersion、研究計画、倫理判断、同意文、装置安全試験、RUNBOOKを作成する。
