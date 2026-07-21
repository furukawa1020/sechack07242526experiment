# テスト報告

対象プロトコル: `R8-010-2x2-mock-v3`

文書状態: **ソフトウェア最終試験済み / 本番NO-GO**

最終確認日: 2026-07-21（Node.js v24.12.0 / npm 11.6.2 / Windows AMD64）

ソフトウェアの最終実測値を次に記録する。本番成果物は、フォーム監査、実機COMポート、実機安全試験が未完了のため生成していない。

| コマンド                                     | 最終結果                                                            | 実行日     |
| -------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| `npm run lint`                               | 成功                                                                | 2026-07-21 |
| `npm run typecheck`                          | 成功                                                                | 2026-07-21 |
| `npm test`                                   | 成功: 24ファイル、264テスト                                         | 2026-07-21 |
| `npm run test:e2e`                           | 成功: Chromium 9テスト                                              | 2026-07-21 |
| `npm run build`                              | 成功                                                                | 2026-07-21 |
| `npm run build:public-demo`                  | 成功                                                                | 2026-07-21 |
| `npm run test:public-demo`                   | 成功: 5画面幅、20テスト、skipなし                                   | 2026-07-21 |
| 公開デプロイスクリプト`--dry-run`            | 成功: README、HTML 5件、同一originのCSS/JSだけを選択                | 2026-07-21 |
| `npm run preflight -- --allow-mock`          | 成功: NO-GO監査を警告し、開発用Mock確認はPASS                       | 2026-07-21 |
| 模擬リハーサル設定でのpreflight              | 成功: loopback、Mock、空フォーム、分離ログを確認                    | 2026-07-21 |
| 模擬リハーサル起動後のhealth/device/operator | 成功: HTTP 200、Mock接続済み、idle、level 0、終了後lockなし         | 2026-07-21 |
| 本番設定での`npm run preflight`              | 予定どおり失敗: `COM0`と`formAudit=NO-GO`の2件                      | 2026-07-21 |
| `npm run audit:form`                         | 予定どおりNO-GO: 内部条件、旧3種類説明、回答タイミングの3ブロッカー | 2026-07-21 |
| `npm audit` / `npm audit --omit=dev`         | 既知脆弱性0件                                                       | 2026-07-21 |

最終カバレッジ:

- Statements: 94.94%（1503/1583）
- Branches: 89.52%（1009/1127）
- Functions: 94.68%（285/301）
- Lines: 95.50%（1446/1514）

研究プロトコル上の重要領域は、全体閾値とは別にファイル単位の閾値を`vitest.config.ts`で強制している。最終実測値は次のとおり。

| 対象 | Statements | Branches | Functions | Lines | 強制閾値 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 条件対応・順序割付 `conditions.ts` | 100% | 100% | 100% | 100% | 全指標100% |
| ステートマシン `experiment-machine.ts` | 96.55% | 95.97% | 100% | 96.42% | 全指標90%以上 |
| Mock装置アダプタ | 97.38% | 90.90% | 96.55% | 97.35% | 全指標90%以上 |
| Serial装置アダプタ | 96.55% | 91.23% | 95.91% | 97.52% | 全指標90%以上 |
| ログ許可フィールド `log-event-allowlist.ts` | 100% | 100% | 100% | 100% | 全指標100% |

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
- リリース生成開始時とmanifest作成直前のGitクリーン状態確認、40文字`sourceCommit`の封印、認証情報を含まないoriginだけを記録する`sourceRepository`
- manifest SHA-256と`sourceCommit`を生成時・検証時の両方で表示し、二名が独立転記できる検証結果
- healthcheckによるappVersion、protocolVersion、config hash、device modeの照合
- 公開静的デモにおける、ページメモリ内だけの4提示自動リハーサル、画面上だけの6秒膨張・保持・6秒収縮、および研究用入力・ログ・装置接続を持たない5つのレビュー経路
- loopback、MockDevice、空フォームURL、分離ログ、模擬IDだけに制限したローカル密封Mockリハーサルと、本番成果物から分離した`sechack-mock-rehearsal-*`生成経路
- `formAudit`による、GO状態、protocol/form URL一致、安定公開payload SHA-256、7日以内の監査日、二名照合を必須にする本番フェイルクローズ

E2Eスイート9ケースはすべて成功した。E2Eでは高速MockDeviceをテスト用途に限って使用し、production成果物にはMock/E2E設定を含めない。Mock装置の膨張命令中に切断を注入し、STOP・DEFLATEの試行、セッションのerror遷移、CSVへのエラー記録も確認した。WebSocketの接続済み通知は、0 ms後の即時判定をやめて状態反映を期限付きで待つ回帰テストへ修正し、対象テストを5回連続で追加実行して全回成功した。

## リリース成果物

`npm run deploy:prepare -- --config config/experiment.production.json`は、品質確認、ビルド、本番ゲートの後、次を含む新規リリースディレクトリを生成する。

- ビルド済みクライアント・サーバ
- コンパイル済みpreflight、healthcheck、manifest検証ツール
- lockfileに固定されたproduction依存関係
- 承認済み本番設定1ファイル
- 運用に必要な固定文書
- 全管理対象ファイルのサイズ・SHA-256と生成元commitを持つschema version 2の`DEPLOYMENT_MANIFEST.json`
- manifest検証、本番起動、healthcheck用Windowsランチャー

リリース生成はGit worktreeがクリーンな場合だけ開始し、manifest作成直前にもHEAD、origin、追跡・未追跡ファイルが変わっていないことを再確認する。既存出力を上書きせず、実ログ、CSV、`.env`、ソース、テスト、Mock/E2E設定、スクリーンショット、source mapを含めない。production起動ランチャーはmanifest検証と`--allow-mock`なしの本番preflightが両方成功した場合だけサーバを起動する。

単一インスタンス用ロックを`data/`へ排他的に作成する。サーバ起動前の二重取得拒否、正常終了時の解放、listen失敗時の解放、異常終了後のstale lock保全・回復、若い不完全ロックの保護、所有者以外からの解放拒否を自動テスト済みである。

実機なしの持ち運び用リハーサルは、`npm run deploy:prepare:rehearsal`でproductionとは別名の`sechack-mock-rehearsal-*`として生成し、`START_MOCK_DEMO.cmd`から起動する。loopback、MockDevice、空のフォームURL、分離された`data/mock-sessions/`だけを許可し、本番リリースや本番GO判定へ転用できない。ビルド済みサーバの起動スモークでは、HTTP 200、Mock接続済み、idle、level 0、faultなし、`/operator`のHTTP 200、終了後のポートとlock解放を確認した。

2026-07-20時点の旧manifest検証では、検証専用の自己完結リリースに123個のproduction依存関係、1,947管理ファイル、20,509,852 bytesが含まれることを確認した。`FORM_AUDIT.md`と単一インスタンスロックが含まれ、SerialPortが同梱され、アプリ固有の`src/`、`tests/`、`artifacts/`、source map、JSONL、CSV、`.env`がないことを確認した。公開済みnpmパッケージ自身に含まれるsource/test/mapはproduction依存関係の一部としてmanifest管理する。検証用設定は実在しない`COM999`を明示しており、当時のmanifest SHA-256は`FEBE394ED1D9FD424CF87E1335ADC9758A333D7CEC2094A5DC6F58CFA91C5656`だった。この旧成果物と設定は削除済みであり、`sourceCommit`を持つschema version 2の現行検証根拠または本番成果物として使用できない。現行の本番成果物は、フォーム監査、COM確定、実機試験に加えてGit作業ツリーをクリーンにした後、新規生成して二名照合する。

## 画面確認

参加者向け固定文言、条件対応、提示時間、固定値は変更していない。`R8-010-2x2-mock-v2`では処理場所へ単色線画のcloud/device iconを追加し、色、大きさ、線幅、占有枠を同一にした。`R8-010-2x2-mock-v3`では、装飾用eyebrow、同心円、軌道、浮遊点を撤去し、共通導入、handling、processing、結果、サマリーの主要内容を表示領域の中央を基準に配置した。条件画面は左右2パネルで画面幅を使い、罫線と余白で構造を示す。参加者が見る刺激の配置と顕著性が変わるため、v3としてプロトコルを更新した。

次の9状態を1366×768と1920×1080の両方で最終撮影し、計18枚を`artifacts/screenshots/`へ保存した。

- スタッフ画面
- 進行中のスタッフ画面
- デバイステスト画面
- 共通導入
- データ取扱いの確認
- 処理中
- 状態ラベルの結果提示
- フグの結果提示
- 4提示のサマリー

最終確認では、参加者画面に内部コードA/B/C/D、研究用ID、内部提示順、装飾用eyebrow、同心円、軌道、浮遊点、英語の小見出しが表示されないことを確認した。共通導入、handling、processing、結果、サマリーの主要内容が中央を基準に配置され、条件画面の左右2パネルが表示領域を使い、主要操作・固定文言が切れないことも自動検査とスクリーンショットで確認した。

## 公開デモ（模擬表示）

実機、入力、研究ログ、API、WebSocket、回答フォームを持たない独立した静的デモを、表示レビュー専用として次の公開先へ配置する。

```text
https://furukawa1020-sechack-experiment-demo.static.hf.space/
```

現行版はHugging Face Static Spaceのcommit `ac32e5ee389c98b4401378301bcff79d91fbcdbb`へデプロイ済みである。配布スクリプトによる許可ファイル一覧とSHA-256の照合、配信commit・固有title・application root・JS/CSS参照の照合、および全5経路のHTTP 200確認に成功した。公開HTTPSを対象にしたPlaywright 20ケースもすべて成功した。

公開静的版の現行ローカルビルド成果物には`/`、`/operator/index.html`、`/display/demo/index.html`、`/device-test/index.html`、`/healthz/index.html`の5経路がある。トップの自動リハーサルは4提示を8秒・3秒・15秒・7秒で進め、フグを画面上だけで6秒膨張・保持・6秒収縮する。進行状態はページメモリだけに置き、研究用ID、同意、フォーム、ログ、API、WebSocket、ブラウザ保存、装置アダプタ、実機命令を使用しない。

`npm run test:public-demo`は1366×768、1920×1080、390×844、320×568、844×390の5画面幅で20/20テストに成功し、skipは0件だった。静的デプロイのdry-runはREADME、HTML 5件、同一originのCSS/JSだけを選択した。cloud/device iconは同じ表示枠、色、線幅、寸法、背景、値の文字スタイルを使用し、可視テキストへ英語の`CLOUD`/`LOCAL`を追加していない。公開後は5経路すべてのHTTP 200と実ブラウザ描画、同一ブラウザ内の表示同期、模擬装置操作を再確認し、外部originへのリクエストとWebSocketはいずれも0件だった。アプリ自身は入力、フォーム、QR、内部コード、研究ログ、実機制御、および能動的な外部通信を持たない。この公開デモは本番実験や実参加者には使用しない。

同日、外部originのHTMLから公開5経路をiframeへ読み込むChromium実測を行い、5経路すべてが描画された。README front matterに`disable_embedding: true`が設定されていても、直接配信される`.static.hf.space` URLへの厳密な埋め込み禁止にはならない。この公開デモは入力、認証、研究データ、フォーム導線、永続状態を持たないため表示レビュー用途に限定して継続するが、HTTPヘッダーによる`frame-ancestors 'none'`を設定できない現行配信先を本番参加者向けに転用しない。

## 本番設定の前提

本番設定で使用予定のGoogleフォームURLは次である。

```text
https://forms.gle/BeShY7cY5zMjunto9
```

アプリはフォームを自動取得・送信せず、参加者の明示操作でのみ開く。

本番設定の`formAudit`はフェイルクローズであり、`status=GO`、同じ設定内の`protocolVersion`と`formUrl`の完全一致、指定フォームURLとの一致、`twoPersonVerified=true`、未来日でない7日以内の`auditedOn`、読取り専用監査で得た安定した`FB_PUBLIC_LOAD_DATA_` payload SHA-256をすべて要求する。欠落、不一致、期限切れ、SHA-256形式不正は本番preflightとproductionサーバ起動の両方で拒否される。現在は`status=NO-GO`、`twoPersonVerified=false`であり、意図どおり本番を拒否した。

2026-07-21の読取り専用再監査では、URLがHTTP 200を返し、想定した研究タイトルと一致すること、および公開フォーム構造に11評価項目があることを確認した。安定した公開payload SHA-256は`33762250e42e9cb63900ccd58a64923f4047693086a81a3737cfe7cbb72d9476`だった。一方、公開payloadに内部条件A〜Dの固定対応が含まれ、3種類と4種類の説明、各提示直後と4提示後の回答説明がそれぞれ併存していた。メール収集設定は機械判定していない。事実、監査限界、解除条件は[Googleフォーム公開内容監査](FORM_AUDIT.md)に記録した。

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
