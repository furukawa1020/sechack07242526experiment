# MockDevice模擬リハーサル（研究参加不可）

## 用途

このモードは、フグ実機、Googleフォーム、実参加者データを使わずに、正式画面、サーバ同期、4提示の自動進行、MockDeviceの動作を確認するためのものです。研究参加、参加同意、回答収集、実機安全試験、本番GO判定には使用しません。

## 起動

```powershell
npm.cmd run rehearsal
```

このコマンドはアプリをビルドしてから、`config/experiment.mock-rehearsal.json`で模擬リハーサル専用サーバを起動します。起動後は次を開きます。

- スタッフ画面: `http://127.0.0.1:4173/operator`
- デバイステスト: `http://127.0.0.1:4173/device-test`
- ヘルスチェック: `http://127.0.0.1:4173/healthz`
- 参加者画面: 模擬セッション作成後にスタッフ画面へ表示されるURL

## 固定された安全境界

設定ファイルだけでなく、サーバ起動時にも次を強制します。一つでも外れると起動しません。

- `device.mode=mock`
- `bindHost=127.0.0.1`
- `network.allowLan=false`
- `network.allowExternalRuntimeRequests=false`
- `formUrl`は空文字
- ログ保存先は`data/mock-sessions/`
- 模擬IDは`DEMO-001`形式

MockDeviceは起動時に自動接続されます。クラウド条件でも外部へ身体データや研究データを送信しません。フォームへのリンク、QR、回答取得、実機Serial通信はありません。

## 操作

1. スタッフ画面で装置モードが「模擬装置」、状態が「待機中」であることを確認します。
2. `DEMO-001`など未使用の模擬IDを入力します。
3. 「リハーサル開始条件を確認済み」にチェックし、提示順を割り付けます。
4. 参加者画面を別ウィンドウで開き、全画面表示と接続を確認します。
5. 共通導入を表示し、4提示を開始します。
6. サマリー後に「リハーサルの確認を完了済み」をチェックして終了します。

`SH26-001`形式の研究用IDや実参加者に結び付く値を入力しないでください。模擬ログを本番ログへ混ぜたり、フォーム回答完了として扱ったりしないでください。

## 封印済み模擬パッケージ

変更をcommitし、`git status --short`が空であることを確認してから次を実行します。

```powershell
npm.cmd run deploy:prepare:rehearsal
```

成果物は`release/sechack-mock-rehearsal-*`へ生成され、`START_MOCK_DEMO.cmd`で起動します。生成・検証時は次を確認します。

- 成果物名がproduction用ではなく`sechack-mock-rehearsal-*`である
- `START_MOCK_DEMO.cmd`が同梱されている
- 設定がMock、loopback、空フォーム、`data/mock-sessions/`、`DEMO-001`形式である
- 実ログ、フォームURL、本番設定、実参加者データを含まない
- 本番リリースへ転用しない旨が表示される

## 公開版との違い

[公開デモ（模擬表示）](PUBLIC_DEMO.md)は外部URLで見た目を確認する静的サイトです。API、WebSocket、ログ、正式な参加者tokenはなく、`/operator/index.html`と`/display/demo/index.html`の同期も同一ブラウザ内だけです。

この模擬リハーサルはローカルNodeサーバ、正式な状態機械、読み取り専用参加者token、WebSocket同期、MockDevice、隔離された模擬ログを使用します。外部インターネットへデプロイせず、`127.0.0.1`でだけ動かします。
