# テスト報告

対象プロトコル: `R8-010-2x2-screen-v1`

最終確認日: 2026-07-21（Windows AMD64 / Node.js 24系）

判定:

- ソフトウェア・画面刺激: **試験合格**
- 公開レビュー版: **デプロイ・外部確認済み**
- 実参加者を対象とする本番: **NO-GO**

正式MVPは、参加者本人を測定しない固定模擬データと、参加者画面内のフグだけを使用する。USB機器、物理フグ、心拍その他の生体センサは不要である。現在のNO-GOは実機未接続によるものではなく、Googleフォーム、研究計画・同意手順、人による承認とパイロットが未完了であるためである。

## 1. 自動試験結果

| コマンド | 結果 |
| --- | --- |
| `npm run lint` | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 成功: 34ファイル、519テスト |
| `npm run test:e2e` | 成功: Chromium 10テスト |
| `npm run build` | 成功 |
| `npm run test:public-demo` | 成功: 5画面幅、25テスト、skipなし |
| 公開HTTPSに対するPlaywright | 成功: 1366×768、5テスト |
| 公開デプロイスクリプト`--dry-run` | 成功: README、HTML 5件、同一originのCSS/JSだけを選択 |
| Mockリハーサル用preflight | 成功。Mockは本番不可と警告した上で開発確認を許可 |
| screen本番設定用preflight | 期待どおり拒否: `formAudit`と`goEvidence`の2項目がFAIL |
| `npm run audit:form` | 期待どおりNO-GO: 公開内容ブロッカー10件 |
| `npm run verify:form-release` | 期待どおり拒否: 公開フォーム不適合、GO証跡未完了 |

最終カバレッジ:

- Statements: 93.19%（2124/2279）
- Branches: 87.58%（1446/1651）
- Functions: 95.96%（381/397）
- Lines: 94.52%（2039/2157）

重要領域の強制閾値:

| 対象 | 最終値または判定 | 強制閾値 |
| --- | --- | --- |
| 条件対応・順序割付 | 全指標100% | 全指標100% |
| ステートマシン | Statements 96.70%、Branches 96.17%、Functions 100%、Lines 96.59% | 全指標90%以上 |
| ScreenPufferDevice | Statements 97.22%、Branches 90%、Functions 100%、Lines 99.24% | 全指標90%以上 |
| MockPufferDevice | Statements 97.38%、Branches 90.90%、Functions 96.55%、Lines 97.35% | 全指標90%以上 |
| SerialPufferDevice（将来境界） | Statements 96.55%、Branches 91.23%、Functions 95.91%、Lines 97.52% | 全指標90%以上 |
| ログ許可フィールド | 全指標100% | 全指標100% |

## 2. 研究条件と画面刺激

自動試験で次を確認した。

- A=cloud+label、B=local+label、C=local+puffer、D=cloud+pufferの固定対応
- ABDC / BCAD / CDBA / DACBの4順序、位置均衡、直前・直後ペア均衡
- 固定値72、高ストレス、pufferLevel 0.60、および全提示時間の一元管理
- A/Bの右側DOM・文言が同一
- C/Dの右側DOM・文言・命令列・画面フグ描画が同一
- 画面フグの6秒膨張、保持、6秒収縮とサーバ時刻同期
- `ScreenPufferDevice`がUSB・ネットワーク・障害注入なしで起動すること
- ビルド済みクライアントを`device.mode=screen`の非参加者テスト用ローカルランタイムで完走できること
- `test`モードがloopback、合成ID、隔離ログ、実フォーム非表示、GO証跡禁止、Serial禁止を強制し、参加者画面とOperatorへ非参加者表示を常設すること
- `development`モードもMock、loopback、`DEV-001`形式、開発専用ログ、空フォームを強制し、参加者画面とOperatorへ非参加者表示を常設すること
- `screen-pilot`モードがScreenPufferDevice、正式固定値・時間・4順序を保ちつつ、loopback、空フォーム、GO証跡禁止、`PILOT-001`形式、隔離ログ、非参加者表示を強制し、Mock・正式ID・本番ログ先・設定上書きを拒否すること
- Mockは開発・E2E・明示的リハーサルだけに限定され、本番で拒否されること
- 通常フェーズの再読み込みはOperator確認まで停止すること
- result/reset中に実際に参加者ページを再読み込みすると、STOP、DEFLATE、errorとなり再開できないこと
- 緊急停止、Mock装置切断、重複研究用ID、不正遷移のフェイルクローズ
- Operatorの1秒challenge/nonce応答・5秒の往復leaseでsilent LAN断、上り・下りのhalf-open、ブラウザ停止を検出し、setup中のlease喪失後は`prepare`・`start`・`resume`を拒否し、進行中の最後のlease喪失ではSTOP・DEFLATE・`OPERATOR_CONNECTION_LOST`、複数接続の1つが生存中は継続すること
- 参加者公開payloadに研究用ID、提示順、A〜D、pufferLevelを出さないこと
- 許可外ログ項目とPII候補を拒否すること
- 実験アプリから外部originへ自動通信しないこと
- 封印済みproduction CLIだけが起動でき、manifest v4と一度だけ読み込んだ設定スナップショットのバイトhash、意味hash、protocolVersion、GO証跡、Git HEADのappVersion、production設定だけを除外した追跡source tree SHA-256、source commitを相互照合すること
- `dist-server/index.js`が汎用`startServer`をexportせず、ソースからの直接production起動も拒否すること
- リリース生成が共有build lockを保持し、検証済みtokenを持つ子ビルドだけを許可して、並行ビルドによる成果物混在を拒否すること
- production設定が固定パスのGit追跡ファイルとバイト単位で一致し、build・依存導入の省略、hardlink、release直下の偽Node実行を拒否すること
- productionリリース生成直前にGoogleフォーム公開内容を再取得し、承認済みhashとの不一致を拒否すること
- 研究用IDをセッション作成時に永続registryへ排他予約し、ログ移動後も再利用しないこと
- JSONLを同一FileHandleから読み、読了後もinode、link数、size、mtime、ctimeを再照合すること
- 除外・削除APIが常に拒否し、読取り専用Preview・UTC保持期限レポートだけがファイルを変更せず動作すること

## 3. UI確認

Playwrightで次の9状態を1366×768と1920×1080の両方で生成し、計18枚を`artifacts/screenshots/`へ保存した。このディレクトリと写真形式はGit対象外である。

- スタッフ画面
- 進行中のスタッフ画面
- 画面刺激テスト
- 共通導入
- データ取扱いの確認
- 処理中
- 状態ラベル結果
- 画面上フグ結果
- 4提示サマリー

目視と自動検査で、中央基準・全画面、日本語中心、英語eyebrowなし、1366×768 / 1920×1080の欠けなしを確認した。クラウドは端末内条件と同じ色・枠・線幅の中立な線画アイコンと日本語「クラウド」で識別できる。赤・緑、安全・危険、推奨・非推奨の価値判断表現はない。

## 4. 公開レビュー版

公開URL:

`https://furukawa1020-sechack-experiment-demo.static.hf.space/`

配信commit:

`72e4c23dd80b31290862fefe01eb3c25045e7ce1`

ルート、operator、display、device-test、healthzの5経路が外部HTTPSからHTTP 200を返すことを確認した。配信commit、許可ファイル一覧、HTMLマーカー、JS/CSSのSHA-256も一致した。公開HTTPSを実ブラウザで5テスト完走し、外部originへの追加リクエストとWebSocketは0件だった。

この公開物はページ内メモリだけで動く表示レビュー用であり、研究参加、同意、研究用ID、Googleフォーム、ログ、API、WebSocket、装置アダプタを持たない。本番実験へ転用しない。

## 5. Googleフォーム監査

対象URL: `https://forms.gle/BeShY7cY5zMjunto9`

安定公開payload SHA-256:

`33762250e42e9cb63900ccd58a64923f4047693086a81a3737cfe7cbb72d9476`

読取り専用再監査の結果はNO-GOである。

- 内部条件A〜Dと処理場所・伝え方の対応を28件検出
- 「3種類」という旧説明を15件検出
- screen版の必須説明6点はすべて0件
- 各提示直後に回答させる旧説明を5件検出
- 研究用ID欄のラベルが固定文言と一致せず、完全一致validationがない
- 提示順・内部コードの入力指示を1件検出
- 禁止された個人情報入力・収集を1件検出
- 研究用ID以外の短文・段落自由記述を3件検出
- 無題の回答入力項目を1件検出
- 11評価質問は存在し、第1〜第4提示、7件法、任意回答で統一
- メール収集、ログイン要求等は管理画面で二名確認が必要

本番設定は、既知NO-GOのhash、`status=NO-GO`、`twoPersonVerified=false`を保持している。フラグだけを変更しても、preflightとリリース直前のlive照合が拒否する。

## 6. 本番GOまでに必要な人の作業

1. 研究責任者が、固定模擬データ、本人非測定、生体データ非取得、画面上フグへの刺激変更を承認する。
2. 所属機関が研究計画変更・倫理審査・変更届の要否を判断し、必要な手続きを完了する。
3. Googleフォーム所有者が`FORM_OWNER_FIX_GUIDE.md`に従って修正する。
4. 提示開始前の同意をどこへ記録するかを承認済み手順へ固定する。
5. 研究用IDで回答とローカル提示順を結合する方法、撤回・除外・削除、保持期間、アクセス権を承認する。
6. 修正後フォームを未ログイン、iPhone、Androidで二名が独立に完走し、機械監査を再実行する。
7. 研究チームの非参加者が`npm run screen-pilot`で異なる`PILOT-xxx`を用いた3〜5件を完走し、表示距離、可読性、全画面、切断時中止、所要時間を確認して、候補commit・設定SHA-256・ログSHA-256を承認済み外部管理票へ記録する。実参加者と正式研究用IDは初回GO前pilotに使用しない。
8. `npm run release:source-evidence`のappVersion、対象設定SHA-256、source tree SHA-256を二名で照合し、承認済みhashと日付を本番設定へ記録する。
9. preflight、liveフォーム照合、productionリリース生成、二名manifest照合をすべてPASSさせる。

物理フグ、COMポート、USBシリアル安全試験は`R8-010-2x2-screen-v1`のGO条件ではない。将来物理フグを使用する場合だけ、別のprotocolVersion、研究責任者承認、必要な倫理手続き、物理安全試験を追加する。

## 7. データ保護確認

- 正式screenアプリはローカルサーバ内で動作し、クラウド条件でも外部送信しない
- フォームは参加者の明示操作でのみ開き、アプリが自動取得・送信しない
- 氏名、メール、IP、位置、カメラ、マイク、ブラウザ指紋、生体データをログへ保存しない
- 外部CDN、外部フォント、分析、広告、テレメトリを使用しない
- 実ログ、スクリーンショット、会場・参加者写真をGitおよび公開成果物へ含めない
- 不可逆な自動除外・自動削除機能を正式リリースへ同梱せず、承認済み外部手順へ限定する
- 研究用ID registryと初期化anchorをセッションJSONLと独立に保全し、外部割付台帳で補完する
- 公開レビュー版は入力・永続化・研究データ経路を持たない
