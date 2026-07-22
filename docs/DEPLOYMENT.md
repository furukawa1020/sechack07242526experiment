# Windowsローカル本番デプロイ

対象プロトコル: `R8-010-2x2-screen-v2`

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

外部調査を使用する場合は、研究スタッフがアプリ外の承認済み手順で案内・運用する。提示前同意もアプリ外の承認済み手順で取得・記録する。アプリ内のセッション完了は外部回答完了を意味しない。

4提示後の参加者画面は次の固定文言だけを表示する。

```text
4つの提示は終了しました

4つの提示は以上です。
研究スタッフの案内をお待ちください。
```

Operatorは一般的なスタッフ引継ぎだけを確認し、`POST /api/sessions/:id/confirm-staff-handoff`でセッションを完了する。

## 3. 本番GO条件

本番は常にフェイルクローズとする。次の6件が、同じprotocolVersion、appVersion、対象設定SHA-256、source tree SHA-256へ結び付いた有効な`goEvidence`でなければ、リリース生成と起動を拒否する。

1. 承認済み研究計画
2. 承認済み倫理判断
3. 提示前同意の承認済み取得・記録手順
4. 承認済みデータ管理計画
5. 研究チームの非参加者によるscreenパイロット3〜5件
6. 独立二名照合

外部回答監査はscreen-v2のリリースゲート・起動ゲートではない。本番設定は`formUrl=""`とし、`formAudit`を含めない。

次もすべて満たす。

- 固定模擬データ、本人非測定、生体データ非取得、画面内フグ、v2の固定文言が研究責任者に承認されている
- 画面刺激版に必要な研究計画変更・倫理手続きが完了している
- 1366×768と1920×1080で全画面を確認している
- C/Dで6秒膨張、保持、6秒収縮が完全に同一である
- `result`/`reset`中の切断がSTOP、DEFLATE、`error`となり再開できない
- 他フェーズの切断後はOperatorの明示確認まで進行しない
- 全自動試験、本番preflight、二名manifest照合が成功している

一つでも不足する場合は**NO-GO**である。

## 4. 本番設定

`config/experiment.production.example.json`から承認対象の`config/experiment.production.json`を作成する。参加者向け文言、条件、順序、固定値、時間、画面フグ動作を変える場合は、先にprotocolVersionと`PROTOCOL_CHANGELOG.md`を更新する。

重要な固定境界は次のとおり。

```json
{
  "protocolVersion": "R8-010-2x2-screen-v2",
  "bindHost": "127.0.0.1",
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

`formAudit`は含めない。`goEvidence`は[本番GO証跡の作成・照合手順](GO_EVIDENCE.md)に従い、氏名、メール、署名画像を入れず、承認文書の非個人識別ID、版、SHA-256、承認日、適用期限を記録する。

## 5. 非参加者screenパイロット

初回GO前に、研究チームの非参加者が異なる`PILOT-xxx`で3〜5件を完走する。

```powershell
npm.cmd run screen-pilot
```

次を確認する。

- 正式固定値、4順序、提示時間、ScreenPufferDevice動作
- 1366×768と1920×1080での可読性、中央配置、表示欠けなし
- Operatorに `非参加者用の事前確認` と `画面版・PILOT/テスト`、参加者側に `非参加者用の事前確認` と `外部回答送信なし` が常設される
- 外部回答導線が表示されない
- 切断、中止、STOP、DEFLATEが安全側へ遷移する
- 実施時のsource commit、source tree SHA-256、pilot設定バイトSHA-256、各ログSHA-256を承認済み外部管理票へ記録する

パイロットは実参加者、正式`SH26-xxx`、外部回答を使用しない。正式成果物へscreen-pilotの設定、起動経路、ログを同梱しない。

## 6. 封印済みリリースの生成

クリーンな承認済みcommitで、必要な5コマンドを実行する。

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

続けてsource evidenceを二名で照合し、リリースを生成する。

```powershell
npm.cmd run release:source-evidence
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

リリース生成は、固定production設定の追跡・HEADバイト一致、appVersion、source commit、production設定だけを除外した追跡source tree SHA-256、pilot設定バイトSHA-256、goEvidence、共有build lockを検証する。失敗を回避するための直接起動、設定差し替え、既存build成果物の流用、環境変数上書きを行わない。

正式成果物へ含めるもの:

- ビルド済みクライアントとサーバ
- production依存関係
- 承認済み設定1ファイル
- manifest検証、preflight、healthcheck
- 本番に必要な実験仕様、固定文言、装置境界、RUNBOOK、GO証跡、データ管理文書
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
4. `VERIFY_RELEASE.cmd`を実行し、全ファイルSHA-256、manifest SHA-256、source commit、appVersion、設定、goEvidenceがPASSすることを二名が独立に確認する。
5. `data/`だけが実行時書込み領域であり、空き容量とアクセス権が適切であることを確認する。
6. 同じ`data/`を使うサーバが起動していないことを確認する。二重起動拒否を別ポートや直接起動で回避しない。

## 8. 起動

1. 不要なクラウド同期、通知、スリープ、ブラウザ拡張を停止する。
2. 物理フグ、USBシリアル、生体センサが未接続であることを確認する。
3. `START_PRODUCTION.cmd`を実行する。
4. `CHECK_HEALTH.cmd`が`R8-010-2x2-screen-v2`、`deviceMode=screen`、承認済み設定hashを返すことを確認する。
5. 同じPCで `http://127.0.0.1:4173/operator` と `/device-test` を開く。
6. ScreenPufferDeviceが`idle`、level 0、faultなしであることを確認する。
7. 6秒膨張、保持、6秒収縮、STOP、DEFLATEを確認する。
8. 参加者画面を同じPCの承認済みChromiumで全画面表示し、1366×768または1920×1080で欠けがないことを確認する。

production起動後に模擬IDの練習セッションを作らない。一般公開URLへ誘導しない。会場ネットワークや別端末へbindしない。

## 9. 停止とログ回収

通常終了はサーバ端末でCtrl+Cを1回押す。STOP、DEFLATE、`idle`、level 0、ポート閉鎖を確認する。端末ウィンドウを先に閉じたり、強制終了したりしない。

実ログはリリース内の`data/sessions/YYYY-MM-DD/`だけに保存する。終了後、件数、研究用ID、終了状態を確認し、承認済み暗号化保存先へ移す。Git、チャット、issue、テスト、再配布物へ含めない。

撤回、分析除外、削除はサーバ停止後、[研究データの撤回・除外・保持期限手順](DATA_LIFECYCLE.md)に従い、研究責任者が承認した外部手順へ引き渡す。アプリ内で不可逆な変更を行わない。

## 10. 将来の物理フグ版

`device.mode=serial`、USBシリアル、空圧、物理緊急停止を使う版はscreen-v2に含めない。実施する場合は、別protocolVersion、研究計画、倫理判断、同意文、装置安全試験、RUNBOOKを作成する。
