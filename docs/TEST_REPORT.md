# テスト報告

対象プロトコル: `R8-010-2x2-mock-v2`

文書状態: **ソフトウェア最終試験済み / 本番NO-GO**

最終確認日: 2026-07-20（Node.js v24.12.0 / Windows AMD64）

ソフトウェアの最終実測値を次に記録する。本番成果物は、フォーム監査、実機COMポート、実機安全試験が未完了のため生成していない。

| コマンド                             | 最終結果                                                             | 実行日時             |
| ------------------------------------ | -------------------------------------------------------------------- | -------------------- |
| `npm run lint`                       | 成功                                                                 | 2026-07-20 21時台 JST |
| `npm run typecheck`                  | 成功                                                                 | 2026-07-20 21時台 JST |
| `npm test`                           | 成功: 18ファイル、168テスト                                          | 2026-07-20 21時台 JST |
| `npm run test:e2e`                   | 成功: Chromium 8テスト                                               | 2026-07-20 21時台 JST |
| `npm run build`                      | 成功                                                                 | 2026-07-20 21時台 JST |
| `npm run build:public-demo`          | 成功                                                                 | 2026-07-20 21時台 JST |
| `npm run test:public-demo`           | 成功: Chromium 2画面幅                                               | 2026-07-20 21時台 JST |
| 公開デプロイスクリプト`--dry-run`    | 成功: README、HTML、同一originのCSS/JSの4ファイルだけを選択          | 2026-07-20 21時台 JST |
| `npm run preflight -- --allow-mock`  | 成功: 開発用Mock確認                                                 | 2026-07-20           |
| 本番設定での`npm run preflight`      | 予定どおり失敗: 未確定の`COM0`のみFAIL                               | 2026-07-20           |
| 封印済み成果物の`VERIFY_RELEASE.cmd` | 検証用`COM999`成果物で成功。検証後に成果物を削除                     | 2026-07-20           |
| 起動後の`CHECK_HEALTH.cmd`           | 検証用成果物で成功。liveness確認のみであり、正式実機成果物では未実行 | 2026-07-20           |

最終カバレッジ:

- Statements: 92.83%（1360/1465）
- Branches: 86.16%（909/1055）
- Functions: 93.77%（271/289）
- Lines: 93.36%（1309/1402）

## 現時点の実装・自動確認範囲

- 条件A〜Dの固定対応
- 4提示順、位置均衡、直前→直後ペア均衡
- A/Bの右パネル同一性
- C/Dの右パネルおよび装置命令同一性
- 固定値のセッション内ロック
- 不正な状態遷移の拒否
- MockDevice正常系と障害注入
- STOP優先、DEFLATE、およびDEFLATE後のSTATUSによる収縮完了確認
- 収縮完了条件`idle`、level 0、faultなしを満たさない場合のfail-closed
- 直列通信のACK/NACK、タイムアウト、状態矛盾、遅延ACK
- 共有されたshutdown処理による重複終了防止
- session側の安全停止が失敗しても、adapter切断・HTTP終了等を継続試行する終了処理
- 設定から導出した安全終了期限と、SIGINT・SIGTERM・SIGBREAK・未処理例外の共通終了経路
- 装置命令の発行・ACK・収縮完了監査ログと、ログ保存障害時のfail-closed
- ログ許可フィールドとPII拒否
- 参加者画面の内部コード非表示
- localhostまたは明示LAN以外への自動通信禁止
- 画面切断、スタッフ画面切断、リロード、緊急停止、重複研究用ID
- 1366×768、1920×1080のオーバーフロー
- productionでのMockDevice無条件拒否。`allowMockInProduction`の値では迂回できない
- production preflightによるSerial、COM、Google Forms、外部通信禁止、ログ書込み・読取り確認
- production依存関係を含む自己完結リリース、厳格なコピー対象、manifest、サイズ・SHA-256検証
- healthcheckによるappVersion、protocolVersion、config hash、device modeの照合

E2Eスイート8ケースはすべて成功した。E2Eでは高速MockDeviceをテスト用途に限って使用し、production成果物にはMock/E2E設定を含めない。WebSocketの接続済み通知は、0 ms後の即時判定をやめて状態反映を期限付きで待つ回帰テストへ修正し、対象テストを5回連続で追加実行して全回成功した。

## リリース成果物

`npm run deploy:prepare -- --config config/experiment.production.json`は、品質確認、ビルド、本番ゲートの後、次を含む新規リリースディレクトリを生成する。

- ビルド済みクライアント・サーバ
- コンパイル済みpreflight、healthcheck、manifest検証ツール
- lockfileに固定されたproduction依存関係
- 承認済み本番設定1ファイル
- 運用に必要な固定文書
- 全管理対象ファイルのサイズ・SHA-256を持つ`DEPLOYMENT_MANIFEST.json`
- manifest検証、本番起動、healthcheck用Windowsランチャー

リリース生成は既存出力を上書きせず、実ログ、CSV、`.env`、ソース、テスト、Mock/E2E設定、スクリーンショット、source mapを含めない。production起動ランチャーはmanifest検証と`--allow-mock`なしの本番preflightが両方成功した場合だけサーバを起動する。

単一インスタンス用ロックを`data/`へ排他的に作成する。サーバ起動前の二重取得拒否、正常終了時の解放、listen失敗時の解放、異常終了後のstale lock保全・回復、若い不完全ロックの保護、所有者以外からの解放拒否を自動テスト済みである。

最終コードから検証専用の自己完結リリースを生成し、123個のproduction依存関係、1,947管理ファイル、20,509,852 bytesをmanifestで検証した。`FORM_AUDIT.md`と単一インスタンスロックが含まれ、SerialPortが同梱され、アプリ固有の`src/`、`tests/`、`artifacts/`、source map、JSONL、CSV、`.env`がないことを確認した。公開済みnpmパッケージ自身に含まれるsource/test/mapはproduction依存関係の一部としてmanifest管理する。検証用設定は実在しない`COM999`を明示しており、manifest SHA-256は`FEBE394ED1D9FD424CF87E1335ADC9758A333D7CEC2094A5DC6F58CFA91C5656`だった。この検証用成果物と設定は誤配布防止のため削除済みであり、本番成果物として使用できない。

## 画面確認

参加者向け固定文言、条件対応、提示時間、固定値は変更していない。UIは装飾用eyebrowと中央寄せメッセージカードを撤去し、左基準・罫線主体の研究機器向け表示へ整理した。処理場所には単色線画のcloud/device iconを追加し、色、大きさ、線幅、占有枠を同一にした。刺激の顕著性が変わるため、プロトコルは`R8-010-2x2-mock-v2`へ更新した。

次の7状態を1366×768と1920×1080の両方で最終撮影し、計14枚を`artifacts/screenshots/`へ保存した。

- スタッフ画面
- 進行中のスタッフ画面
- デバイステスト画面
- 共通導入
- 状態ラベルの結果提示
- フグの結果提示
- 4提示のサマリー

最終確認では、参加者画面に内部コードA/B/C/D、研究用ID、内部提示順、装飾用eyebrowが表示されないこと、中央カードへ戻っていないこと、主要操作・固定文言が切れないことを目視確認した。

## 公開Mockデモ

実機、入力、研究ログ、API、WebSocket、回答フォームを持たない独立した静的デモを、表示レビュー専用として次へデプロイした。

```text
https://furukawa1020-sechack-experiment-demo.static.hf.space/
```

Hugging Face Spaceは`sdk: static`、commit `d7ea7ca537e009d8d2df441b20781a22ee62e2c5`で稼働中である。公開成果物は`README.md`、`index.html`、同一originのJavaScriptとCSSだけで、設定、ログ、サーバコード、フォームURLを含まない。再デプロイ手順は、今回成功した`HfApi.create_commit`方式と同じ明示的許可リストを使う`deploy/huggingface-space/deploy.py`へ固定した。

`npm run test:public-demo`は1366×768と1920×1080の2件に成功した。cloud/device iconは同じ表示枠、色、線幅、寸法、背景、値の文字スタイルを使用し、可視テキストへ英語の`CLOUD`/`LOCAL`を追加していない。公開URLをChromiumで再確認し、HTTP 200、雲アイコン表示、実機なし表示、入力・リンク・フォーム・QR・内部コードがないこと、fetch/XHR/WebSocketが0件であることを確認した。この公開デモは本番実験や実参加者には使用しない。

## 本番設定の前提

本番設定で使用予定のGoogleフォームURLは次である。

```text
https://forms.gle/BeShY7cY5zMjunto9
```

アプリはフォームを自動取得・送信せず、参加者の明示操作でのみ開く。

2026-07-20の読取り専用監査では、URLがHTTP 200を返し、想定した研究タイトルと一致すること、および公開フォーム構造に11評価項目があることを確認した。一方、公開payloadに内部条件A〜Dの固定対応が含まれ、3種類と4種類の説明、各提示直後と4提示後の回答説明がそれぞれ併存していた。メール収集設定は機械判定していない。事実、監査限界、解除条件は[Googleフォーム公開内容監査](FORM_AUDIT.md)に記録した。

したがって、URL、QR、研究説明、同意、4提示後の回答手順、実際に回答できる11問、メールその他の個人情報を収集しない設定を修正後のフォームで二名が照合し、再監査が完了するまでフォーム受入は失敗扱いとする。HTTP 200またはタイトル一致だけを合格根拠にしてはならない。

## 本番GOを禁止する未完了事項

現時点の判定は**NO-GO**である。次のすべてが完了するまで、本番参加者を対象に起動してはならない。

1. [Googleフォーム公開内容監査](FORM_AUDIT.md)の未解決所見が残り、修正後の二名再監査が完了していない。
2. 実機のWindows COMポートが未確定であり、本番設定と実機の照合が完了していない。
3. USBシリアル実機を用いた現地試験が未完了である。

現地試験には最低限、PING、STATUS、最大上限、6秒膨張、保持、6秒収縮、収縮完了、STOP、ACK timeout、USB切断、fault、通信断時排気、停電・PC断、物理緊急停止、空気漏れ・異音・異臭・過熱確認を含める。

COM確定後に本番設定を封印し、新しいmanifestを生成する。既存manifestや設定を手編集して流用してはならない。

## 最終承認に必要な人による確認

- 固定模擬データ方式と承認済み研究計画の一致
- Googleフォーム監査所見の解消と、同意・4提示後の回答手順・11問・メール非収集・QRの二名照合
- 実機側の圧力クランプと通信断フェイルセーフ
- 物理緊急停止
- 空気漏れ、収縮完了、連続運転時の発熱
- 会場での可読性、表示方向、ブラウザ全画面
- manifest、設定SHA-256、appVersion、protocolVersionの二名照合
- [Windowsローカル本番デプロイ](DEPLOYMENT.md)と[リリース二名照合票](RELEASE_CHECKLIST.md)の全項目完了
