# Windowsローカル本番デプロイ

対象プロトコル: `R8-010-2x2-mock-v1`

この手順は、実験会場のWindows PCへ、外部通信を行わないローカルWebアプリとして配置するためのものです。公開クラウドや一般公開Webサーバへデプロイしません。

現在の本番判定は**NO-GO**です。GoogleフォームURLと11評価項目は確認済みですが、[公開内容監査](FORM_AUDIT.md)で内部条件対応の公開、旧新説明の併存、回答タイミングの不整合が見つかっています。加えて、実機COMポートの確定とUSBシリアル実機を用いた現地安全試験も完了していません。フォーム再監査、COM確定、実機試験をすべて完了し、新しい本番設定とmanifestを封印するまで参加者を対象に起動してはなりません。

## 1. 完了条件

ソフトウェアのビルド成功だけでは本番デプロイ完了としません。次をすべて満たす必要があります。

- 研究責任者が固定模擬データ方式と参加者向け文言を承認済み
- 指定済みGoogleフォームURL`https://forms.gle/BeShY7cY5zMjunto9`を設定済み
- [Googleフォーム公開内容監査](FORM_AUDIT.md)の未解決所見が0件で、11問とメール非収集を二名が実回答経路で照合済み
- `device.mode`が`serial`
- 実機COMポートを設定済み
- `allowMockInProduction`が`false`
- `allowExternalRuntimeRequests`が`false`
- 全自動テストと本番preflightが成功
- 実機の物理緊急停止、上限、排気、通信断、停電試験が成功
- 生成されたmanifestと設定SHA-256を2名で照合済み

一つでも未確認なら、リリース生成または起動を失敗させたままにします。

productionサーバは`device.mode=mock`を無条件に拒否します。`allowMockInProduction=true`へ変更してもproduction Mockを許可する経路にはなりません。この値は必ず`false`のままにします。

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
  "formUrl": "https://forms.gle/BeShY7cY5zMjunto9"
}
```

フォームURLは上記の値に固定します。ただし、URLが正しいこととフォーム内容が承認済みであることは別です。現在の公開フォームは[公開内容監査](FORM_AUDIT.md)のNO-GO所見を解消していません。フォーム所有者による修正後、URL、QR、研究説明、同意、4提示後の回答手順、11問、メールその他の個人情報を収集しない設定を2名で照合します。アプリはこのURLを自動取得・送信しません。

`COM3`は例であり、現時点では未確定です。Windowsのデバイスマネージャーと実機の抜き差しで対象ポートを特定し、装置担当者と2名で照合してから置き換えます。COM未確定の設定、`COM0`、空文字の設定は本番リリースに使用しません。

## 3. 封印済みリリースを生成する

ビルドPCで次を実行します。

```powershell
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

このコマンドは、Lint、型検査、単体・統合テスト、現行8ケースのE2E、ビルド、本番preflightを順に実行します。その後、`release/`の新しいディレクトリへ許可ファイルだけをコピーし、lockfileからproduction依存関係を導入します。2026-07-20の最終ソフトウェア試験は17ファイル・163テスト、E2E 8テストが成功し、カバレッジはStatements 92.83%、Branches 86.16%、Functions 93.77%、Lines 93.36%でした。実測値は[テスト報告](TEST_REPORT.md)へ記録しています。

成果物には次が含まれます。

- ビルド済みクライアントとサーバ
- コンパイル済みpreflight、healthcheck、manifest検証ツール
- production依存関係（SerialPortのWindows用モジュールを含む）
- 承認済み設定1ファイル
- RUNBOOK、装置仕様、実験仕様、固定文言、Googleフォーム公開内容監査
- 全管理対象ファイルのサイズとSHA-256を記録した`DEPLOYMENT_MANIFEST.json`
- Windows用の検証・起動・ヘルスチェックランチャー

実ログ、CSV、`.env`、ソース、テスト、E2E設定、Mock設定、スクリーンショットは入りません。既存の出力先を上書きしないため、設定を直した場合は新しいリリースを生成します。

manifestはappVersion、protocolVersion、設定内容SHA-256、ビルド時Node・OS・architecture、および全管理対象ファイルのサイズ・SHA-256を保持します。実行用ランチャー、production設定、文書、production依存関係も検証対象です。`data/`は実行時書込み領域としてmanifest対象外ですが、生成直後は`.gitkeep`以外を含まないことを確認します。

サーバは`data/.experiment-server.lock`を排他的に取得し、同じデータ領域での二重起動を拒否します。正常終了と起動失敗では所有権を確認して解放します。異常終了後のstale lockは別名で保全して警告し、装置状態と中断ログの確認を促します。二重起動拒否、正常解放、listen失敗時解放、stale lock回復、所有者以外からの解放拒否は自動テスト済みです。

## 4. 会場PCへ配置する

1. リリースディレクトリ全体を、クラウド同期対象外のローカルディスクへコピーします。
2. ビルド時と完全に同じNode.jsバージョン、Windowsアーキテクチャを使用します。値は`DEPLOYMENT_MANIFEST.json`の`buildRuntime`で確認します。
3. 会場PCでは`npm install`、`npm ci`、buildを実行しません。
4. `VERIFY_RELEASE.cmd`を実行し、`PASS`を確認します。
5. manifestのconfig SHA-256を、別経路で保管した承認記録と2名で照合します。
6. `data/`だけが書込み可能で、Git・OneDrive等の同期対象外であることを確認します。
7. 同じリリースまたは同じ`data/`を使うサーバが起動していないことを確認します。ロック取得失敗時は二重起動を疑い、別ポートや直接起動で回避しません。stale lock警告が出た場合は、実機が完全に収縮していることと中断ログを確認してから続行します。

JS、設定、文書、依存モジュールのいずれかが変更・欠落している場合、検証は失敗します。検証失敗を無視して直接`node`を実行しません。

## 5. 起動と確認

1. 隔離LAN、UPS、実機、物理緊急停止をRUNBOOKどおり確認します。
2. `START_PRODUCTION.cmd`を実行します。
3. ランチャーがmanifest検証と本番preflightを再実行し、両方に成功した場合だけサーバが起動します。
4. 別の端末で`CHECK_HEALTH.cmd`を実行し、manifest・設定と同じappVersion、protocolVersion、config hash、`deviceMode=serial`が表示されることを確認します。
5. `http://127.0.0.1:4173/operator`と`/device-test`を開き、実機疎通試験後に練習セッションを完走します。
6. 1366×768と1920×1080で、装飾用eyebrowと中央寄せメッセージカードがなく、左基準・罫線主体の表示になっていることを承認済みスクリーンショットと照合します。参加者向け固定文言や条件間レイアウトを変更してはいけません。

LAN公開時のOperator tokenは起動端末にだけ表示されます。写真、スクリーンショット、チャット、ログへ保存しません。

`CHECK_HEALTH.cmd`はサーバのlivenessと設定一致を確認するもので、実機の準備完了を保証しません。`/device-test`でPING、STATUS、idle、level 0、faultなし、STOP、DEFLATEと収縮完了を確認するまでセッションを開始しません。

## 6. 停止

通常終了は、サーバ端末でCtrl+Cを1回だけ押します。SIGINT、SIGTERM等は共有された1回のshutdown処理へ合流し、重複終了操作では新しい安全停止を開始しません。STOP、DEFLATE、STATUSによる`idle`・level 0・faultなしの収縮完了、安全終了、ポート閉鎖を確認してから装置電源を切ります。端末ウィンドウを先に閉じたり、タスクマネージャーで強制終了したりしません。

終了処理が設定から導出した期限内に完了しない場合、または収縮完了を確認できない場合は、正常終了と扱いません。画面表示を待たず物理状態を確認し、必要なら物理緊急停止を実施します。

異常膨張、漏れ、異音、過熱、STOP/DEFLATE無応答では、画面やCtrl+Cを待たず物理緊急停止を最優先します。

## 7. ログ回収

実ログはリリース内の`data/sessions/YYYY-MM-DD/`にだけ保存されます。終了後、件数・研究用ID・終了状態を確認し、研究計画で承認された暗号化保存先へ移します。実ログをリリース再配布物、Git、チャット、issue、テストへ含めません。

## 8. 最終GO判定

[リリース二名照合票](RELEASE_CHECKLIST.md)を2名で確認します。特に次は書類上の確認だけで済ませてはなりません。

- 実機COMポートと本番設定の一致
- [Googleフォーム公開内容監査](FORM_AUDIT.md)の全解除条件と再監査の完了
- 公開payloadから内部コードA/B/C/Dと固定対応が除去されていること
- 提示数、回答タイミング、11問およびメール非収集設定の二名照合
- PING、STATUS、6秒膨張、保持、6秒収縮、収縮完了
- STOP、ACK timeout、USB切断、fault、通信断時排気
- 停電・PC断、物理緊急停止、最大上限
- 空気漏れ、異音、異臭、過熱、連続動作

一つでも未完了または結果不明なら判定は**NO-GO**です。COMまたは設定を変更した場合は既存成果物を手編集せず、ビルドPCで新しい自己完結リリースとmanifestを生成し直します。
