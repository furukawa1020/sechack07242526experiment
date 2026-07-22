# Windowsローカル本番デプロイ

対象プロトコル: `R8-010-2x2-screen-v1`

この手順は、実験会場のWindows PCへ、研究データを外部へ自動送信しないローカルWebアプリとして配置するためのものです。提示終了後のGoogleフォームは参加者が明示操作で別経路から開き、その時点以降は参加者のブラウザとGoogleが通信します。正式アプリを公開クラウドや一般公開Webサーバへデプロイしません。

## 実機なしの模擬リハーサル

実参加者を扱わずに正式画面とサーバ同期を確認する場合は、`npm.cmd run rehearsal`を使用する。専用設定`config/experiment.mock-rehearsal.json`はloopback、MockDevice、空のフォームURL、`data/mock-sessions/`だけを許可し、サーバ起動時にMockDeviceを自動準備する。IDは`DEMO-001`形式だけを使い、研究用IDや実参加者に結び付く値を入力しない。操作と安全境界は[実機なし模擬リハーサル](MOCK_REHEARSAL.md)を参照する。

自動試験の`test`モードも非参加者専用である。`mock`または`screen`だけを許可し、loopback、外部通信なし、実フォームとGO監査証跡なし、フォーム誘導なし、Serialなし、`TEST-001`または`DEMO-001`形式の合成ID、隔離ログを起動時に強制する。参加者画面とOperatorには非参加者表示を常設する。`test`を本番起動、参加者募集、同意取得、Googleフォーム受入の代替にしてはならない。

持ち運び用の封印済み成果物は、変更をcommitして作業ツリーをクリーンにした後、`npm.cmd run deploy:prepare:rehearsal`で生成する。成果物名は`sechack-mock-rehearsal-*`、起動ファイルは`START_MOCK_DEMO.cmd`であり、production成果物とは別系統に固定する。このモードは研究参加、同意、Googleフォーム受入、画面刺激版の研究承認、screen本番試験の代替ではなく、本番GO判定へ使用してはならない。

画面だけを外部ブラウザで確認する場合は、[公開デモ（模擬表示）](PUBLIC_DEMO.md)の静的な自動リハーサルを使用する。トップ画面は、ページメモリ内だけで4提示を8秒・3秒・15秒・7秒の固定時間で進行し、フグも画面上だけで6秒膨張・保持・6秒収縮する。研究用ID、同意、フォーム、ログ、API、WebSocket、装置アダプタ、実機命令は使用しない。`npm.cmd run test:public-demo`は1366×768、1920×1080、390×844、320×568、844×390の5画面幅を25テスト・skipなしで確認する。これも表示レビュー専用であり、本番GO判定やローカルサーバ同期試験の代替ではない。

現在の人対象本番判定は**NO-GO**です。ソフトウェアは、固定模擬データと画面上のフグを用いる実機不要の正式`screen`モードへ移行しています。一方、[公開内容監査](FORM_AUDIT.md)では内部条件対応の公開、旧新説明の併存、回答タイミングの不整合、screen版の必須説明不足、無題入力、研究用ID欄のラベル・形式検証、提示順コードの入力指示が残っています。画面刺激版の研究計画・同意方法・データ管理・倫理判断・パイロットの承認、フォーム修正・二名照合、本番preflightを完了し、新しいmanifestを封印するまで参加者へ提示してはなりません。

## 1. 完了条件

ソフトウェアのビルド成功だけでは本番デプロイ完了としません。次をすべて満たす必要があります。

- 研究責任者が、本人を測定しない固定模擬データ、生体データ非取得、画面上のフグ、参加者向け文言を承認済み
- 物理フグ版から画面刺激版への変更について、所属機関で必要な研究計画変更・倫理手続きを完了済み
- 提示開始前の同意を事後評価フォームとは別の承認済み経路で記録し、研究用IDによるフォーム回答・ローカル提示順の連結方法も承認済み
- 指定済みGoogleフォームURL`https://forms.gle/BeShY7cY5zMjunto9`を設定済み
- [Googleフォーム公開内容監査](FORM_AUDIT.md)の未解決所見が0件で、研究用ID 1件＋11評価グリッドだけという回答項目契約とメール非収集を二名が実回答経路で照合済み
- 本番設定の`formAudit`が`status=GO`、対象`protocolVersion`と`formUrl`の完全一致、公開payload SHA-256の一致、`twoPersonVerified=true`、未来日でない7日以内の`auditedOn`をすべて満たす
- 本番設定の`goEvidence`が、研究計画、倫理判断、提示前同意、データ管理、3〜5件のscreenパイロット、独立二名照合を同じprotocolVersionと対象設定SHA-256へ結び付け、すべて有効期限内の`GO`である
- `device.mode`が`screen`で`serialPath`が空、物理フグ・USBシリアル・生体センサが未接続
- `allowMockInProduction`が`false`
- `allowExternalRuntimeRequests`が`false`
- 全自動テストと本番preflightが成功
- 6秒膨張・保持・6秒収縮を確認済み。継続接続中の再描画はサーバ時刻へ同期し、`result`/`reset`中の再読み込み・切断はSTOP、DEFLATE、`error`で再開不能、他フェーズはOperator確認まで停止する
- 生成元Git作業ツリーがクリーンで、固定パス`config/experiment.production.json`がGit追跡済みかつHEADのバイト列と完全一致
- `releaseVerification.appVersion`がGit HEADの`package.json.version`、`releaseVerification.sourceTreeSha256`と`screenPilot.sourceTreeSha256`がproduction設定だけを除外したHEADの全追跡tree SHA-256と一致し、`screenPilot.pilotConfigFileHash`がHEADの固定pilot設定バイトSHA-256と一致
- manifest schema version 4の40文字`sourceCommit`が最終commitと一致し、生成時と検証時のmanifest SHA-256、source tree SHA-256、appVersion、設定SHA-256を2名で照合済み

一つでも未確認なら、リリース生成または起動を失敗させたままにします。

productionサーバは`device.mode=mock`を無条件に拒否します。`screen`は外部通信や故障注入を行わない正式アダプタであり、Mockを本番許可する抜け道ではありません。`allowMockInProduction`は必ず`false`のままにします。

## 2. ビルドPCで本番設定を作る

`config/experiment.production.example.json`を`config/experiment.production.json`へコピーし、研究責任者が承認した値だけを設定します。参加者向け文言、条件、提示時間、固定値、フグ動作を変える場合は、先に`protocolVersion`と`PROTOCOL_CHANGELOG.md`を更新します。

本番設定には次を含めます。

```json
{
  "device": {
    "mode": "screen",
    "serialPath": "",
    "baudRate": 115200,
    "ackTimeout": 1000,
    "allowMockInProduction": false
  },
  "formUrl": "https://forms.gle/BeShY7cY5zMjunto9"
}
```

フォームURLは上記の値に固定します。ただし、URLが正しいこととフォーム内容が承認済みであることは別です。現在の公開フォームは[公開内容監査](FORM_AUDIT.md)のNO-GO所見を解消していません。フォーム所有者による修正後、URL、QR、研究説明、4提示後の回答手順、研究用ID 1件＋11評価グリッドだけという回答項目契約、メールその他の個人情報を収集しない設定を2名で照合します。提示前同意はこの事後評価フォームとは別の承認済み経路を二名で確認します。アプリはこのURLを自動取得・送信しません。

二名照合と研究責任者承認の完了後に限り、本番設定の`formAudit`へ`GO`、同じ`protocolVersion`と`formUrl`、監査日、`npm.cmd run audit:form`が表示した安定した`FB_PUBLIC_LOAD_DATA_` payloadのSHA-256、`twoPersonVerified=true`を転記する。本番preflightとproductionサーバ起動は、欠落、不一致、未来日、8日以上の経過、SHA-256形式不正、および既知のNO-GO公開payload SHA-256をすべて拒否する。監査コマンドは読取り専用であり、設定を自動更新したりNO-GOをGOへ変更したりしない。

`goEvidence`は[本番GO証跡の作成・照合手順](GO_EVIDENCE.md)に従って作成する。承認者名、メールアドレス、署名画像は設定へ入れず、外部管理された承認文書の非個人識別ID、版、SHA-256、承認日、今回の実施への適用期限だけを記録する。preflightが算出した`criticalConfigSha256`と、二名の独立した照合記録が一致しなければ本番は失敗する。

`screen`モードでは`serialPath`を必ず空文字にし、物理装置を接続しません。COMポートを指定するとschemaと本番preflightが失敗します。将来の`serial`物理版は別プロトコルとして作成し、この設定や承認記録を流用しません。

## 3. 封印済みリリースを生成する

リリース対象をcommitした後、ビルドPCで`git status --short`が何も出力しないことを確認します。未追跡ファイルを含む変更が1件でもある場合、リリース生成は失敗します。`npm.cmd run release:source-evidence`で表示されるGit HEAD由来の`appVersion`、`criticalConfigSha256`、`pilotConfigFileHash`、`sourceTreeSha256`、40文字の`sourceCommit`を二名照合票へ転記します。screen-pilot実施時の`sourceTreeSha256`と`configFileHash`が、それぞれこの`sourceTreeSha256`と`pilotConfigFileHash`に一致しなければパイロットを再実施します。production設定だけを最終更新してcommitした後に同コマンドを再実行し、appVersion、対象設定SHA-256、pilot設定バイトSHA-256、source tree SHA-256が照合時と同一であることを確認します。

続けて次を実行します。

```powershell
npm.cmd run deploy:prepare -- --config config/experiment.production.json
```

このコマンドは、Lint、型検査、単体・統合テスト、E2E、ビルド、公開フォームの読取り専用照合、本番preflightを順に実行します。その後、Git作業ツリーのクリーン状態、固定production設定の追跡・HEAD完全一致、source tree SHA-256、appVersionを照合し、`release/`の新しいディレクトリへ許可ファイルだけをコピーして、lockfileからproduction依存関係を導入します。productionでは既存build成果物の再利用と依存導入の省略を拒否します。コピー元は通常ファイル・単一hardlinkであることを確認し、open後のfile identityと読取り後のmetadataを再照合します。途中でHEAD、origin、追跡・未追跡ファイルが変わった場合も失敗します。最新の件数とカバレッジは[テスト報告](TEST_REPORT.md)へ記録します。フォームまたは統合GO証跡がNO-GOの間は、意図どおりproduction成果物の生成に失敗します。

成果物には次が含まれます。

- ビルド済みクライアントとサーバ
- コンパイル済みpreflight、healthcheck、manifest検証
- production依存関係
- 承認済み設定1ファイル
- RUNBOOK、装置仕様、実験仕様、固定文言、Googleフォーム公開内容監査、GO証跡手順、データlifecycle手順
- 全管理対象ファイルのサイズとSHA-256、生成元commitを記録した`DEPLOYMENT_MANIFEST.json`
- Windows用の検証・起動・ヘルスチェックランチャー

実ログ、CSV、`.env`、ソース、テスト、E2E設定、Mock設定、screen-pilot設定・起動entry・ログ、スクリーンショットは入りません。既存の出力先を上書きしないため、設定を直した場合は新しいリリースを生成します。

manifest schema version 4はappVersion、protocolVersion、設定ファイルと設定内容のSHA-256、GO証跡を除く対象設定SHA-256、GO証跡SHA-256、40文字の`sourceCommit`、production設定だけを除外したHEADの全追跡tree SHA-256、これらのbinding SHA-256、認証情報を含まない場合に限る`sourceRepository`、ビルド時Node・OS・architecture、および全管理対象ファイルのサイズ・SHA-256を保持します。appVersionは管理対象`package.json.version`およびGO証跡、source tree SHA-256はGO証跡と一致しなければ検証失敗とします。manifest自身を含む管理対象ファイルは通常ファイルかつhardlink数1だけを許可します。実行用ランチャー、production設定、文書、production依存関係も検証対象です。`data/`は実行時書込み領域としてmanifest対象外ですが、生成直後は`.gitkeep`以外を含まないことを確認します。production CLIは固定設定を一度だけ読み、そのバイトSHA-256、意味SHA-256、対象設定SHA-256、GO証跡SHA-256、protocolVersionを検証済みmanifestと照合した同一スナップショットでサーバを起動し、実行時表示と監査ログのappVersionにも検証済みmanifest値を使用します。

リリース生成は`release/.build.lock`を生成前から最終renameまで排他的に保持する。子のclient/serverビルドだけがランダムtokenを継承でき、同時に開始された無関係なビルドまたは別リリースは失敗する。通常ビルド同士は短い上限時間内で直列化する。異常終了でlockが残った場合は自動削除しない。タスクマネージャー等で関連するNode/npm/Codexプロセスが存在しないことを確認し、lockの内容と未完了`.staging-*`を調査してから、運用責任者が手動で対処する。

生成完了時に表示される`Deployment manifest SHA-256`と`Source commit`を照合者2名がそれぞれ独立に二名照合票へ転記し、値を突き合わせます。画面共有した1人の転記をもう1人がそのまま写す方式にはしません。manifestまたは成果物を手編集するとSHA-256検証が失敗するため、変更時は必ずクリーンなGit状態から新規生成します。

サーバは`data/.experiment-server.lock`を排他的に取得し、同じデータ領域での二重起動を拒否します。正常終了と起動失敗では所有権を確認して解放します。異常終了後のstale lockは別名で保全して警告し、装置状態と中断ログの確認を促します。二重起動拒否、正常解放、listen失敗時解放、stale lock回復、所有者以外からの解放拒否は自動テスト済みです。

## 4. 会場PCへ配置する

1. リリースディレクトリ全体を、クラウド同期対象外のローカルディスクへコピーします。
2. ビルド時と完全に同じNode.jsバージョン、Windowsアーキテクチャを`%ProgramFiles%\nodejs\node.exe`へ導入します。production用`.cmd`はこの絶対パスの存在確認後にだけ起動し、release直下の`node.cmd`等を実行しません。値は`DEPLOYMENT_MANIFEST.json`の`buildRuntime`で確認します。
3. 会場PCでは`npm install`、`npm ci`、buildを実行しません。
4. `VERIFY_RELEASE.cmd`を実行し、`Deployment manifest SHA-256`、`Source commit`、`PASS`を確認します。
5. 検証時のmanifest SHA-256と`sourceCommit`が生成時に2名で転記した値と一致し、manifestのconfig SHA-256が別経路で保管した承認記録と一致することを2名で照合します。
6. `data/`だけが書込み可能で、Git・OneDrive等の同期対象外であることを確認します。
7. 同じリリースまたは同じ`data/`を使うサーバが起動していないことを確認します。ロック取得失敗時は二重起動を疑い、別ポートや直接起動で回避しません。stale lock警告が出た場合は、未終端セッション、中断ログ、画面刺激が停止状態であることを確認してから続行します。

JS、設定、文書、依存モジュールのいずれかが変更・欠落している場合、検証は失敗します。検証失敗を無視して直接`node`を実行しません。`dist-server/index.js`は封印起動関数だけを公開し、汎用`startServer`は公開しません。ソースの`startServer({ mode: "production" })`も常に拒否されます。

## 5. 起動と確認

1. 隔離LANまたは単一PC、UPS、物理装置・生体センサの未接続、画面刺激をRUNBOOKどおり確認します。
2. `START_PRODUCTION.cmd`を実行します。
3. ランチャーがmanifest検証と本番preflightを再実行し、両方に成功した場合だけサーバが起動します。
4. 同じPCの別PowerShellウィンドウで`CHECK_HEALTH.cmd`を実行し、manifest・設定と同じappVersion、protocolVersion、config hash、`deviceMode=screen`が表示されることを確認します。
5. `http://127.0.0.1:4173/operator`と`/device-test`を開き、6秒膨張・保持・6秒収縮・STOP・DEFLATEの画面刺激試験を完了します。production起動後に模擬IDの練習セッションを作成しません。セッションを用いる確認は、研究責任者が承認したscreenパイロットだけを承認済み研究用ID・記録手順で実施します。
6. 1366×768と1920×1080で、装飾用eyebrow、同心円、軌道、浮遊点、英語の小見出しがなく、共通導入・フェーズ案内・結果・サマリーの主要内容が表示領域の中央を基準に配置されていることを承認済みスクリーンショットと照合します。条件画面は左右2パネルで画面幅を使い、罫線と余白で構造を示します。参加者向け固定文言や条件間レイアウトを変更してはいけません。

LAN公開時のOperator tokenは起動端末にだけ表示されます。写真、スクリーンショット、チャット、ログへ保存しません。

`CHECK_HEALTH.cmd`はサーバのlivenessと設定一致を確認するもので、画面刺激の見た目を保証しません。`/device-test`と参加者画面でScreenPufferDeviceの論理ready/status、`idle`、level 0、faultなし、STOP、DEFLATE、収縮完了を目視確認するまでセッションを開始しません。USBのPING、STATUS、ACKを求める確認ではありません。

## 6. 停止

通常終了は、サーバ端末でCtrl+Cを1回だけ押します。SIGINT、SIGTERM等は共有された1回のshutdown処理へ合流し、重複終了操作では新しい安全停止を開始しません。STOP、DEFLATE、ScreenPufferDeviceの論理statusによる`idle`・level 0・faultなし、安全終了、ポート閉鎖を確認します。端末ウィンドウを先に閉じたり、タスクマネージャーで強制終了したりしません。

終了処理が設定から導出した期限内に完了しない場合、または画面刺激の停止を確認できない場合は正常終了と扱いません。ブラウザを閉じるだけで済ませず、中断ログと終了状態を確認します。

## 7. ログ回収

実ログはリリース内の`data/sessions/YYYY-MM-DD/`にだけ保存されます。終了後、件数・研究用ID・終了状態を確認し、研究計画で承認された暗号化保存先へ移します。実ログをリリース再配布物、Git、チャット、issue、テストへ含めません。

撤回、分析除外、削除は、サーバ停止後に研究責任者が事前承認した外部手順へ引き渡す。正式リリースは`DATA_LIFECYCLE.cmd`、変更用CLI、変更用npm scriptを同梱せず、アプリ内APIも常に拒否する。開発リポジトリの読取り専用Preview/保持期限レポートは対象確認の参考に限り、変更権限を与えない。Googleフォーム側は同じ研究用IDを管理者が別途手動照合する。詳細は[研究データの撤回・除外・保持期限手順](DATA_LIFECYCLE.md)に従う。

## 8. 最終GO判定

[リリース二名照合票](RELEASE_CHECKLIST.md)を2名で確認します。特に次は書類上の確認だけで済ませてはなりません。

- `deviceMode=screen`、空の`serialPath`、物理装置・生体センサ未接続
- [Googleフォーム公開内容監査](FORM_AUDIT.md)の全解除条件と再監査の完了
- 公開payloadから内部コードA/B/C/Dと固定対応が除去されていること
- 提示数、回答タイミング、11問およびメール非収集設定の二名照合
- ScreenPufferDeviceの論理ready/status、6秒膨張、保持、6秒収縮、収縮完了。継続接続中だけサーバ時刻へ同期し、`result`/`reset`中の再読み込みは安全停止して再開不能、他フェーズはOperator確認まで停止する
- STOP、DEFLATE、参加者画面・スタッフ画面切断、停電・PC断時の中断
- 提示開始前の同意記録方法、研究用ID連結、画面刺激版の責任者承認
- `goEvidence`の研究計画、倫理判断、提示前同意、データ管理、screenパイロット、独立二名照合と、算出済み対象設定SHA-256の一致

一つでも未完了または結果不明なら判定は**NO-GO**です。設定を変更した場合は既存成果物を手編集せず、ビルドPCで新しい自己完結リリースとmanifestを生成し直します。Hugging Face上の公開静的版は表示レビュー専用であり、本番サーバ、同意、割付、監査ログの代替にはなりません。
