# SecHack365 実験提示システム

同一の固定身体状態データを4条件で提示する、人対象研究向けのローカルWebアプリです。研究スタッフ画面、参加者画面、フグ型デバイス確認画面を1台のローカルサーバから配信し、サーバ側の状態機械で提示時間を統一します。

このアプリは診断システムではありません。「クラウド」は比較用シナリオであり、身体データや研究データを実際のクラウドへ送信しません。

## 必要環境

- Node.js 22以上（開発確認はNode.js 24）
- npm 11以上
- Chromium系ブラウザ
- 実機利用時のみ、USBシリアル接続されたフグ型デバイス

外部CDN、外部フォント、分析サービスは使用しません。npmパッケージの取得後、実験実行時の通信先はローカルサーバだけです。

## セットアップ

```bash
npm ci
npm run build
```

MockDeviceで開発・デモする場合は、次で起動します。

```bash
npm run preflight -- --allow-mock
npm run dev
```

USBシリアル実機を設定した本番運用では、ビルド後に次で起動します。

```bash
npm run preflight
npm run start
```

`npm run preflight`は既定で本番ゲートです。Serial実機モード、Windows COMポート、`allowMockInProduction=false`、指定済みGoogle Forms URL形式、`allowExternalRuntimeRequests=false`を満たさない場合は終了コード1で失敗します。`npm run start`も本番モードで、Mock設定では安全のため起動を拒否します。

会場へ配置する本番成果物は、ソースディレクトリをそのままコピーせず、次のコマンドで生成します。

```powershell
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

このコマンドは指定された5つの品質確認、ビルド、本番preflightを完了した後、`release/`へproduction依存関係を含む封印済みディレクトリを作成します。実ログ、ソース、テスト、Mock/E2E設定は含めません。会場では同梱の`VERIFY_RELEASE.cmd`と`START_PRODUCTION.cmd`を使用し、npm installや再ビルドを行いません。詳細は[Windowsローカル本番デプロイ](docs/DEPLOYMENT.md)を参照してください。

起動後に開く画面：

- スタッフ画面: `http://127.0.0.1:4173/operator`
- デバイステスト: `http://127.0.0.1:4173/device-test`
- ヘルスチェック: `http://127.0.0.1:4173/healthz`
- 参加者画面: セッション作成後にスタッフ画面へ表示される`/display/:token`

## MockDeviceでのデモ

1. `config/experiment.json`の`device.mode`が`mock`であることを確認し、`npm run dev`で起動します。
2. スタッフ画面を開き、装置表示がMockであることを確認して「装置を接続」を押します。
3. 研究用ID（例: `SH26-001`）を入力し、同意確認済みにチェックします。
4. 自動割付または提示順を選び、セッションを作成します。
5. 表示された参加者画面URLを別ウィンドウで開き、F11またはkioskで全画面表示します。
6. 接続と全画面を目視確認してスタッフ画面の確認欄へチェックし、共通導入を表示して4提示を開始します。
7. サマリー後、Googleフォームでの回答完了を確認してセッションを完了します。
8. 必要ならCSVを出力します。

参加者画面には内部コードA/B/C/Dを表示しません。スタッフ画面では監査と進行確認のためだけに表示します。
デバイステスト画面ではINFLATE・DEFLATE・STOPの実ACKと`requestId`を表示します。最後のスタッフ画面接続が実行中に失われた場合は、無人進行を防ぐためSTOP/DEFLATEとerror遷移を行います。

## 実機接続

`config/experiment.json`の次の値を会場環境に合わせて設定します。

```json
{
  "device": {
    "mode": "serial",
    "serialPath": "COM3",
    "baudRate": 115200,
    "ackTimeout": 1000,
    "allowMockInProduction": false
  }
}
```

本番前に`/device-test`でPING、STATUS、上限以下の膨張、収縮、STOPを確認してください。詳細は[運用手順](docs/RUNBOOK.md)と[装置通信仕様](docs/DEVICE_PROTOCOL.md)を参照してください。

新しい本番設定は`config/experiment.production.example.json`から作成します。例には提供済みフォームURL`https://forms.gle/BeShY7cY5zMjunto9`が反映されています。意図的に無効な値は`COM0`だけであり、実機の確定COMポートへ置換するまで本番ゲートを通過しません。URLが設定済みでもフォーム内容の承認を意味しません。[Googleフォーム公開内容監査](docs/FORM_AUDIT.md)のNO-GO所見を解消し、二名照合を完了する必要があります。

## 本番前点検

本番用設定を確定した後、起動と同じユーザー・同じ環境変数で実行します。

```bash
npm run preflight
npm run build
npm run start
```

点検結果には、解決済み設定パスとSHA-256、`protocolVersion`、装置モード・COM・baud・ACK timeout、固定状態、Google Forms URL、bind/LAN設定、ログ保存先と空き容量が表示されます。機密の操作トークンや環境変数全体は表示しません。別設定は`npm run preflight -- --config config/会場用設定.json`で指定できます。

`--allow-mock`は開発用Mock確認だけを通す例外で、本番承認の代わりにはなりません。終了コードが1、または`FAIL`が1件でもあれば本番を開始しないでください。

実験PCと表示端末は、インターネットへ出られない隔離LANまたは単一PC構成で運用します。Googleフォームは別端末・別経路で開き、実験アプリから自動送受信しません。LAN運用時の操作トークンは画面・ログ・手順書・チャット・スクリーンショットへ転記しないでください。

## 設定

既定設定は`config/experiment.json`です。別ファイルを使う場合は`EXPERIMENT_CONFIG_PATH`を設定します。ログ保存先だけを`DATA_DIRECTORY`で上書きできます。

参加者向け文言、条件定義、提示時間、固定値、フグ動作を変える場合は、研究責任者の確認後に`protocolVersion`と[プロトコル変更履歴](docs/PROTOCOL_CHANGELOG.md)を更新してください。

## ログとデータ保護

- JSONLログ: `data/sessions/YYYY-MM-DD/`
- CSV: スタッフ画面または`GET /api/exports/sessions.csv`
- 記録対象: 研究用ID、提示順、条件、フェーズ、時刻、固定値、装置イベント、終了状態
- 記録禁止: 氏名、メール、IP、User-Agent全文、位置情報、生体データ、Googleフォーム回答、自由記述

`data/sessions/`はGit管理外です。実参加者ログをfixtureやissueへコピーしないでください。

## 品質確認

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

E2Eは高速MockDeviceを使用し、4つの提示順と主要障害系を確認します。スクリーンショットは`npm run screenshots`で`artifacts/screenshots/`へ生成します。

## 仕様

- [実験仕様](docs/EXPERIMENT_SPEC.md)
- [参加者向け固定文言](docs/UI_COPY.md)
- [装置通信仕様](docs/DEVICE_PROTOCOL.md)
- [運用手順](docs/RUNBOOK.md)
- [Windowsローカル本番デプロイ](docs/DEPLOYMENT.md)
- [本番リリース二名照合票](docs/RELEASE_CHECKLIST.md)
- [テスト報告](docs/TEST_REPORT.md)
- [Googleフォーム公開内容監査](docs/FORM_AUDIT.md)
- [プロトコル変更履歴](docs/PROTOCOL_CHANGELOG.md)
- [合成サンプルログ](docs/examples/sample-session.jsonl)

正式実施前に、固定模擬データ方式が承認済み研究計画と一致していることを研究責任者が確認してください。実センサ連携はこの版の対象外です。
