# テスト報告

対象プロトコル: `R8-010-2x2-screen-v2`

文書・受入基準更新日: 2026-07-22（Windows AMD64）

## 現在の判定

- screen-v2仕様・固定文言・運用境界: 更新済み
- screen-v2コードの最終5コマンド: この文書へ確定値を転記するまで未確定
- 実参加者を対象とする本番: 6件の`goEvidence`と最終リリース照合が完了するまで**NO-GO**

最終リリース候補で、次の5コマンドを同じcommitから実行し、件数・カバレッジ・実行日時をこの文書へ確定値で追記する。過去版の成功結果や部分実行をscreen-v2の合格記録として流用しない。

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
```

## 1. screen-v2最終実測欄

| コマンド | 結果 | 実測日時 |
| --- | --- | --- |
| `npm run lint` | 最終リリース候補で再実行待ち | |
| `npm run typecheck` | 最終リリース候補で再実行待ち | |
| `npm test` | 最終リリース候補で再実行待ち | |
| `npm run test:e2e` | 最終リリース候補で再実行待ち | |
| `npm run build` | 最終リリース候補で再実行待ち | |

最終カバレッジ:

- Statements:
- Branches:
- Functions:
- Lines:

重要領域の強制閾値:

| 対象 | 強制閾値 |
| --- | --- |
| 条件対応・順序割付 | 全指標100% |
| ステートマシン | 全指標90%以上 |
| ScreenPufferDevice | 全指標90%以上 |
| MockPufferDevice | 全指標90%以上 |
| SerialPufferDevice（将来境界） | 全指標90%以上 |
| ログ許可フィールド | 全指標100% |

## 2. 変更していない研究刺激

screen-v2への版更新理由は、4提示後の参加者向け文言と一般的なスタッフ引継ぎ方式の変更である。次の研究刺激はscreen-v1から変更していない。

- A=cloud+label、B=local+label、C=local+puffer、D=cloud+puffer
- ABDC / BCAD / CDBA / DACBの4順序
- 固定値72、高ストレス、pufferLevel 0.60
- 8秒 / 3秒 / 15秒 / 7秒の提示時間
- A/Bの同一右表示
- C/Dの同一右表示・命令列・画面フグ描画
- 6秒膨張、結果終了まで保持、6秒収縮
- 継続接続中のサーバ時刻同期

これらを既存回帰試験と全4順序E2Eで再確認する。

## 3. screen-v2固有の受入試験

### 参加者画面

- サマリー見出しが `4つの提示は終了しました`
- サマリー本文が次の2行と完全一致する

```text
4つの提示は以上です。
研究スタッフの案内をお待ちください。
```

- 外部フォーム・外部調査の名称を表示しない
- 外部回答導線を表示しない
- 回答方法、回答完了確認を表示しない
- 参加者向け固定文言に仮説や期待結果を表示しない

### Operator・API

- 完了操作は一般的なスタッフ引継ぎ確認である
- `POST /api/sessions/:id/confirm-staff-handoff`だけがsummaryからcompletedへ進める
- 外部回答の有無・内容・完了を入力または表示しない
- 旧完了経路を正式UI・正式API契約として残さない

### 設定とruntime

- 正式設定は`R8-010-2x2-screen-v2`
- `bindHost=127.0.0.1`
- `device.mode=screen`
- `serialPath=""`
- `allowMockInProduction=false`
- `network.allowExternalRuntimeRequests=false`
- `formUrl=""`
- `formAudit`が存在しない
- 正式runtimeから外部originへのrequestが0件

screen-v1の外部回答監査はscreen-v2のrelease/start gateとして試験しない。

## 4. 回帰試験

次を自動試験で確認する。

- 条件対応、位置均衡、直前・直後ペア均衡
- 全4順序をScreenPufferDeviceで完走
- 通常フェーズの再読み込みはOperator確認まで停止
- `result`/`reset`中の再読み込みはSTOP、DEFLATE、`error`となり再開不能
- 緊急停止、装置境界切断、重複研究用ID、不正遷移のフェイルクローズ
- 最後のOperator lease喪失でSTOP、DEFLATE、`OPERATOR_CONNECTION_LOST`
- 参加者公開payloadに研究用ID、提示順、A〜D、pufferLevelを出さない
- 許可外ログ項目とPII候補を拒否
- 研究用IDregistryへ排他予約し、ログ移動後も再利用しない
- JSONLを同一FileHandleから読み、読了後もfile identityとmetadataを再照合
- 除外・削除APIが常に拒否し、読取り専用PreviewとUTC保持期限レポートだけが動作
- production CLIが封印済みmanifest経由だけで起動
- 直接production起動、設定差し替え、既存build流用、環境変数上書きを拒否
- build lock、単一server lock、stale lock回復

## 5. UI確認

1366×768と1920×1080で、次の9状態を確認する。

- スタッフ画面
- 進行中のスタッフ画面
- 画面刺激テスト
- 共通導入
- データ取扱いの確認
- 処理中
- 状態ラベル結果
- 画面上フグ結果
- 4提示サマリー

確認項目:

- 中央基準・全画面・日本語中心
- 英語eyebrow、同心円、軌道、浮遊点がない
- 条件画面は左右2パネルで表示領域を使う
- クラウドと端末内は同じ色・枠・線幅の中立な線画と日本語で識別
- 赤・緑、安全・危険、推奨・非推奨がない
- 表示欠け、不要なスクロールがない
- C/Dの画面上フグが完全に同一

スクリーンショットは`artifacts/screenshots/`へローカル生成し、Git、正式成果物、公開物へ含めない。

## 6. 非参加者screenパイロット

研究チームの非参加者が、異なる`PILOT-xxx`で3〜5件を完走する。

- `研究参加用ではありません・外部回答送信なし`を参加者側とOperatorへ常設
- 外部回答導線なし
- 正式固定値、4順序、提示時間、ScreenPufferDeviceを使用
- 実参加者、正式ID、外部回答を使用しない
- source commit、source tree SHA-256、pilot設定バイトSHA-256、ログSHA-256を外部管理票へ記録
- リリース候補のsource evidenceと一致

このパイロットと独立二名照合は`goEvidence`の必須項目であり、未完了なら本番はNO-GOである。

## 7. 正式成果物検査

正式成果物に次が含まれないことをmanifestと独立ファイル一覧で確認する。

- `FORM_*`
- `MOCK_REHEARSAL.md`とMock用資材
- `PUBLIC_DEMO.md`と公開レビュー用資材
- screen-pilot用設定・起動経路・ログ
- ソース、テスト、E2E設定、スクリーンショット
- 実ログ、CSV、`.env`

正式deploymentは会場Windows PC 1台と`127.0.0.1`だけで行う。一般公開またはHugging Face上の静的レビュー版は正式productionとして検査・承認しない。

## 8. 本番GOまでに必要な人の作業

1. 研究責任者が固定模擬データ、本人非測定、生体データ非取得、画面内フグ、v2固定文言とスタッフ引継ぎ方式を承認する。
2. 所属機関が研究計画変更・倫理審査・変更届の要否を判断し、必要な手続きを完了する。
3. 提示前同意をアプリ外の承認済み手順へ固定する。
4. データ管理、撤回、除外、削除、保持期間、アクセス権を承認する。
5. 非参加者screenパイロット3〜5件を完了する。
6. 二名がリリースsource evidence、設定、goEvidence、manifestを独立に照合する。
7. 最終5コマンド、本番preflight、現地screen試験をPASSさせる。

物理フグ、COMポート、USBシリアル安全試験はscreen-v2のGO条件ではない。将来物理フグを使用する場合だけ、別protocolVersionと物理安全試験を追加する。

## 9. データ保護

- 正式screenアプリはローカルサーバ内で動作し、クラウド条件でも外部送信しない
- 外部回答を取得、表示、送信、複製、完了確認しない
- 氏名、メール、IP、位置、カメラ、マイク、ブラウザ指紋、生体データをログへ保存しない
- 外部CDN、外部フォント、分析、広告、テレメトリを使用しない
- 実ログ、スクリーンショット、会場・参加者写真をGitおよび正式成果物へ含めない
- 不可逆な自動除外・自動削除機能を正式成果物へ同梱しない
- 研究用IDregistryと初期化anchorをセッションJSONLと独立に保全する

## 10. screen-v1の履歴値

2026-07-21にscreen-v1で記録されたテスト件数・カバレッジ・公開レビュー確認は履歴であり、screen-v2正式リリースの合格記録ではない。必要な履歴はGit履歴またはscreen-v1当時の承認済み外部記録を参照し、上記のscreen-v2最終実測欄へ混在させない。
