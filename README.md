# SecHack365 実験提示システム

参加者本人を測定したものではない同一の固定模擬データを4条件で提示する、人対象研究向けのローカルWebアプリです。研究スタッフ画面、参加者画面、画面上のフグ確認画面を1台のローカルサーバから配信し、サーバ側の状態機械で提示時間を統一します。正式MVPは`R8-010-2x2-screen-v1`です。

このアプリは診断システムではありません。この版では心拍その他の生体データを取得しません。「クラウド」は比較用シナリオであり、このアプリから固定模擬身体データやローカル実験ログを外部へ送信しません。アンケート回答だけは、参加者がGoogleフォーム上で明示的に送信したときにGoogleへ送信・保存されます。

> **現在の判定:** 実機なしの正式`screen`アプリと公開レビュー版は技術試験済みです。実参加者を対象とする本番だけは、Googleフォームの未解決所見、提示前同意の記録方法、研究計画との整合確認、二名照合、研究責任者承認が完了するまで**NO-GO**です。ソフトウェアはこれらを満たさない本番起動・リリース生成を自動的に拒否します。

## 必要環境

- Node.js 22以上（開発確認はNode.js 24）
- npm 11以上
- Chromium系ブラウザ

正式MVPにUSBシリアル機器や物理フグは不要です。

外部CDN、外部フォント、分析サービスは使用しません。npmパッケージの取得後、提示アプリが自動通信する相手はローカルサーバだけです。提示終了後に参加者がGoogleフォームを明示的に開いた時点以降は、そのブラウザとGoogleの間で通信します。

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

実機・Googleフォーム・実参加者データを使わず、正式画面と自動進行を確認する場合は、次の1コマンドで模擬リハーサルを起動します。

```bash
npm run rehearsal
```

このモードは`config/experiment.mock-rehearsal.json`を使い、`127.0.0.1`だけで待ち受け、MockDeviceを自動準備します。フォームURLは空で、ログは`data/mock-sessions/`へ分離されます。本番参加者には使用できません。

正式な実機なし`screen`モードの本番運用では、ビルド後に次で起動します。

```bash
npm run preflight -- --config config/experiment.production.json
EXPERIMENT_CONFIG_PATH=config/experiment.production.json npm run start
```

PowerShellでは起動前に`$env:EXPERIMENT_CONFIG_PATH = "config/experiment.production.json"`を設定してから`npm.cmd run start`を実行します。ソースツリーの既定`config/experiment.json`は開発用Mockなので、本番設定を明示せずに正式版を起動できません。封印済みproductionリリースでは、承認済み設定が`config/experiment.json`として同梱され、`START_PRODUCTION.cmd`が検証後に起動します。

本番preflightは、プロトコル`R8-010-2x2-screen-v1`、`device.mode=screen`、空のシリアルパス、`allowMockInProduction=false`、指定Google Forms URLとの完全一致、7日以内の二名監査GO、`allowExternalRuntimeRequests=false`を満たさない場合は終了コード1で失敗します。production起動も同じ設定・フォーム監査ゲートを再検証し、監査記録の欠落・NO-GO・設定との不一致・期限切れ、現在のscreenプロトコルに対する`mock`または`serial`設定があれば起動を拒否します。

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

## 公開レビュー版（実機不要）

画面確認専用の静的な模擬版は、次のURLで公開しています。固定模擬データと画面上のフグだけを使い、研究用ID、フォーム、ログ、API、WebSocket、USBシリアル、実機命令を含みません。本番実験や実参加者には使用しないでください。

- [6画面の手動確認・自動リハーサル](https://furukawa1020-sechack-experiment-demo.static.hf.space/)
- [公開レビュー進行画面](https://furukawa1020-sechack-experiment-demo.static.hf.space/operator/index.html)
- [読み取り専用の参加者表示](https://furukawa1020-sechack-experiment-demo.static.hf.space/display/demo/index.html)
- [模擬装置確認](https://furukawa1020-sechack-experiment-demo.static.hf.space/device-test/index.html)
- [公開版の稼働確認](https://furukawa1020-sechack-experiment-demo.static.hf.space/healthz/index.html)

公開版の配信commitは`14d6a6069c30c63aa1d1561c7d8b6e9a9d94f2d0`です。正式なローカル版と公開レビュー版の差は[公開デモ（模擬表示）](docs/PUBLIC_DEMO.md)を参照してください。

公開版の直接URLは外部サイトのiframe内でも表示できるため、埋め込み禁止を必要とする本番用途には使えません。入力・認証・研究データを持たない表示レビュー専用です。

## MockDeviceでのデモ

通常は、上記の`npm run rehearsal`を使用してください。ビルド後にスタッフ画面`http://127.0.0.1:4173/operator`を開けば、実機なしで4提示を完走できます。

模擬リハーサルでは次の手順だけを使用します。

1. `npm run rehearsal`を実行し、スタッフ画面を開きます。
2. 装置モードが「模擬装置」、状態が「待機中」であることを確認します。
3. 模擬ID（例: `DEMO-001`）を入力し、「リハーサル開始条件を確認済み」にチェックします。
4. 提示順を割り付け、読み取り専用の参加者画面を別ウィンドウで開きます。
5. 全画面表示と接続を確認し、4提示を開始します。
6. サマリーで「リハーサルの確認を完了済み」にチェックして終了します。

この経路にはGoogleフォームへのリンクや回答確認はありません。`SH26-001`形式の研究用ID、実参加者、実回答、実機は使用しないでください。詳しい安全境界は[実機なし模擬リハーサル](docs/MOCK_REHEARSAL.md)にまとめています。

ソース変更中に開発サーバを使う場合だけ、以下の手順を使用します。

1. `config/experiment.json`の`device.mode`が`mock`であることを確認し、`npm run dev`で起動します。
2. スタッフ画面を開き、装置表示がMockであることを確認して「装置を接続」を押します。
3. 開発用ID（例: `DEV-001`）を入力し、リハーサル開始条件を確認します。
4. 自動割付または提示順を選び、セッションを作成します。
5. 表示された参加者画面URLを別ウィンドウで開き、F11またはkioskで全画面表示します。
6. 接続と全画面を目視確認してスタッフ画面の確認欄へチェックし、共通導入を表示して4提示を開始します。
7. サマリー後、リハーサルの確認を完了してセッションを終了します。
8. 必要ならCSVを出力します。

会場へ持ち運べる実機なしの封印済みリハーサルパッケージは、変更をcommitして作業ツリーをクリーンにした後、次で生成します。

```powershell
npm.cmd run deploy:prepare:rehearsal
```

生成物は`sechack-mock-rehearsal-*`という別名になり、`START_MOCK_DEMO.cmd`から起動します。本番リリースへ転用できません。

参加者画面には内部コードA/B/C/Dを表示しません。スタッフ画面では監査と進行確認のためだけに表示します。
デバイステスト画面では、モードを明示したうえでINFLATE・DEFLATE・STOPの状態を表示します。正式な`screen`では画面上のフグとサーバ時刻同期を確認し、USB ACKは使用しません。将来の`serial`だけが実ACKと`requestId`を扱います。最後のスタッフ画面接続が実行中に失われた場合は、無人進行を防ぐためSTOP/DEFLATEとerror遷移を行います。

## 正式版の実機なし設定

正式MVPの本番設定では、次の境界を固定します。

```json
{
  "protocolVersion": "R8-010-2x2-screen-v1",
  "device": {
    "mode": "screen",
    "serialPath": "",
    "baudRate": 115200,
    "ackTimeout": 1000,
    "allowMockInProduction": false
  }
}
```

本番前に`/device-test`で、画面上のフグが`result`開始から6秒で膨張し、結果終了まで保持され、`reset`開始から6秒で収縮することと、STOP後に収縮することを確認してください。描画は継続接続中のサーバ時刻に同期します。`result`または`reset`中の再読み込みは刺激欠損としてセッションを安全停止し、再開しません。他フェーズの再読み込みでは進行を止め、再接続後もOperatorの明示確認まで再開しません。CとDの動作は完全に同一でなければなりません。詳細は[運用手順](docs/RUNBOOK.md)と[装置境界仕様](docs/DEVICE_PROTOCOL.md)を参照してください。

新しい本番設定は`config/experiment.production.example.json`から作成します。例には提供済みフォームURL`https://forms.gle/BeShY7cY5zMjunto9`が反映されています。意図的な本番ブロッカーは`formAudit.status=NO-GO`と未完了の二名照合です。[Googleフォーム公開内容監査](docs/FORM_AUDIT.md)の所見を0件にし、研究責任者の承認を得て二名照合を完了するまで、本番ゲートを通過しません。

`serial`による物理フグはこのプロトコルの対象外です。物理フグへ戻す場合は、研究刺激の変更として研究責任者の承認と所属機関で必要な倫理審査・変更手続きを完了し、別の`protocolVersion`で実施してください。

`formAudit`には監査対象の`protocolVersion`、`formUrl`、`auditedOn`、公開応答内の安定した`FB_PUBLIC_LOAD_DATA_` payloadの`contentSha256`、非個人識別の`twoPersonVerified`だけを記録します。確認者の氏名、メールアドレス、フォーム回答は設定へ保存しません。現在の記録は2026-07-21の再監査結果を`NO-GO`として明示しています。

## 本番前点検

本番用設定を確定した後、起動と同じユーザー・同じ環境変数で実行します。

```bash
npm run preflight -- --config config/experiment.production.json
npm run build
EXPERIMENT_CONFIG_PATH=config/experiment.production.json npm run start
```

点検結果には、解決済み設定パスとSHA-256、`protocolVersion`、正式`screen`モード・空のシリアルパス、固定状態、Google Forms URL、フォーム監査の状態・対象・日付・公開内容SHA-256・二名確認、bind/LAN設定、ログ保存先と空き容量が表示されます。確認者名、機密の操作トークン、環境変数全体は表示しません。別設定は`npm run preflight -- --config config/会場用設定.json`で指定できます。

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

E2Eは高速MockDeviceを使用し、4つの提示順と主要障害系を確認します。スクリーンショットは`npm run screenshots`で`artifacts/screenshots/`へローカル生成し、Gitおよび公開・本番成果物には含めません。

## 仕様

- [実験仕様](docs/EXPERIMENT_SPEC.md)
- [参加者向け固定文言](docs/UI_COPY.md)
- [装置通信仕様](docs/DEVICE_PROTOCOL.md)
- [運用手順](docs/RUNBOOK.md)
- [実機なし模擬リハーサル](docs/MOCK_REHEARSAL.md)
- [公開デモ（模擬表示）](docs/PUBLIC_DEMO.md)
- [Windowsローカル本番デプロイ](docs/DEPLOYMENT.md)
- [本番リリース二名照合票](docs/RELEASE_CHECKLIST.md)
- [テスト報告](docs/TEST_REPORT.md)
- [Googleフォーム公開内容監査](docs/FORM_AUDIT.md)
- [プロトコル変更履歴](docs/PROTOCOL_CHANGELOG.md)
- [専用Mockリハーサル設定に紐付く合成サンプルログ](docs/examples/sample-session.jsonl)

正式実施前に、固定模擬データ方式、本人非測定、生体データ非取得、および画面上フグへの刺激変更が承認済み研究計画と一致していることを研究責任者が確認してください。所属機関で必要な倫理審査・変更手続きが未完了なら実参加者へ使用しないでください。実センサ連携と物理フグはこの版の対象外です。
