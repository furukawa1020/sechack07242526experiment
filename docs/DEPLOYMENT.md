# Windowsローカル本番デプロイ

対象プロトコル: `R8-010-2x2-mock-v1`

この手順は、実験会場のWindows PCへ、外部通信を行わないローカルWebアプリとして配置するためのものです。公開クラウドや一般公開Webサーバへデプロイしません。

## 1. 完了条件

ソフトウェアのビルド成功だけでは本番デプロイ完了としません。次をすべて満たす必要があります。

- 研究責任者が固定模擬データ方式と参加者向け文言を承認済み
- 承認済みGoogleフォームURLを設定済み
- `device.mode`が`serial`
- 実機COMポートを設定済み
- `allowMockInProduction`が`false`
- `allowExternalRuntimeRequests`が`false`
- 全自動テストと本番preflightが成功
- 実機の物理緊急停止、上限、排気、通信断、停電試験が成功
- 生成されたmanifestと設定SHA-256を2名で照合済み

一つでも未確認なら、リリース生成または起動を失敗させたままにします。

## 2. ビルドPCで本番設定を作る

`config/experiment.production.example.json`を`config/experiment.production.json`へコピーし、研究責任者と装置担当者が承認した値だけを設定します。参加者向け文言、条件、提示時間、固定値、フグ動作を変える場合は、先に`protocolVersion`と`PROTOCOL_CHANGELOG.md`を更新します。

本番設定には次を含めます。

```json
{
  "device": {
    "mode": "serial",
    "serialPath": "COM3",
    "baudRate": 115200,
    "ackTimeout": 1000,
    "allowMockInProduction": false
  },
  "formUrl": "https://docs.google.com/forms/d/e/承認済みID/viewform"
}
```

`COM3`やURLは例のまま使わず、実機と承認済みフォームを照合します。

## 3. 封印済みリリースを生成する

ビルドPCで次を実行します。

```powershell
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

このコマンドは、Lint、型検査、単体・統合テスト、E2E、ビルド、本番preflightを順に実行します。その後、`release/`の新しいディレクトリへ許可ファイルだけをコピーし、lockfileからproduction依存関係を導入します。

成果物には次が含まれます。

- ビルド済みクライアントとサーバ
- コンパイル済みpreflight、healthcheck、manifest検証ツール
- production依存関係（SerialPortのWindows用モジュールを含む）
- 承認済み設定1ファイル
- RUNBOOK、装置仕様、実験仕様、固定文言
- 全管理対象ファイルのサイズとSHA-256を記録した`DEPLOYMENT_MANIFEST.json`
- Windows用の検証・起動・ヘルスチェックランチャー

実ログ、CSV、`.env`、ソース、テスト、E2E設定、Mock設定、スクリーンショットは入りません。既存の出力先を上書きしないため、設定を直した場合は新しいリリースを生成します。

## 4. 会場PCへ配置する

1. リリースディレクトリ全体を、クラウド同期対象外のローカルディスクへコピーします。
2. ビルド時と完全に同じNode.jsバージョン、Windowsアーキテクチャを使用します。値は`DEPLOYMENT_MANIFEST.json`の`buildRuntime`で確認します。
3. 会場PCでは`npm install`、`npm ci`、buildを実行しません。
4. `VERIFY_RELEASE.cmd`を実行し、`PASS`を確認します。
5. manifestのconfig SHA-256を、別経路で保管した承認記録と2名で照合します。
6. `data/`だけが書込み可能で、Git・OneDrive等の同期対象外であることを確認します。

JS、設定、文書、依存モジュールのいずれかが変更・欠落している場合、検証は失敗します。検証失敗を無視して直接`node`を実行しません。

## 5. 起動と確認

1. 隔離LAN、UPS、実機、物理緊急停止をRUNBOOKどおり確認します。
2. `START_PRODUCTION.cmd`を実行します。
3. ランチャーがmanifest検証と本番preflightを再実行し、両方に成功した場合だけサーバが起動します。
4. 別の端末で`CHECK_HEALTH.cmd`を実行し、設定と同じ`protocolVersion`、`deviceMode=serial`が表示されることを確認します。
5. `http://127.0.0.1:4173/operator`と`/device-test`を開き、実機疎通試験後に練習セッションを完走します。

LAN公開時のOperator tokenは起動端末にだけ表示されます。写真、スクリーンショット、チャット、ログへ保存しません。

## 6. 停止

通常終了は、サーバ端末でCtrl+Cを1回だけ押します。STOP、DEFLATE、安全終了、ポート閉鎖を確認してから装置電源を切ります。端末ウィンドウを先に閉じたり、タスクマネージャーで強制終了したりしません。

異常膨張、漏れ、異音、過熱、STOP/DEFLATE無応答では、画面やCtrl+Cを待たず物理緊急停止を最優先します。

## 7. ログ回収

実ログはリリース内の`data/sessions/YYYY-MM-DD/`にだけ保存されます。終了後、件数・研究用ID・終了状態を確認し、研究計画で承認された暗号化保存先へ移します。実ログをリリース再配布物、Git、チャット、issue、テストへ含めません。
