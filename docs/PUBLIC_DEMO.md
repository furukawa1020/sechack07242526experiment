# 公開デモ（模擬表示）の配布と確認

## 用途と禁止事項

公開デモ（模擬表示）は、固定模擬データによる画面表示だけをブラウザで確認する静的サイトである。研究参加、参加同意、回答収集、実機制御には使用しない。

公開成果物には、正式な研究スタッフ画面、研究用ID入力、同意確認、提示順割付、参加者token、REST API、WebSocket、ログ、CSV、装置アダプタ、USBシリアル通信、回答フォーム、QRコード、分析、テレメトリ、外部CDN、外部フォントを含めない。「クラウド」は比較用シナリオの表示文言だけであり、外部へ身体データを送信しない。

公開版には、表示レビュー専用の固定経路を用意する。これらは正式実験の同名画面ではなく、研究参加や研究データを扱わない静的な模擬表示である。

| 経路 | 用途 | 制約 |
|---|---|---|
| `/` | 6画面の手動確認と固定時間の自動リハーサル | ページメモリだけで進行 |
| `/operator/index.html` | 表示レビュー用の進行操作 | 研究用ID・同意・割付・ログなし |
| `/display/demo/index.html` | 読み取り専用の参加者表示レビュー | 固定パスで、参加者tokenではない |
| `/device-test/index.html` | 模擬装置の画面状態確認 | Serial・装置アダプタ・実機命令なし |
| `/healthz/index.html` | 静的成果物の配信確認 | 動的なサーバーヘルスチェックではない |

`/operator/index.html`と`/display/demo/index.html`の同期には`BroadcastChannel`を使い、同一origin・同一ブラウザ・同一端末のタブ間で表示番号だけを一時伝達する。別端末や別ブラウザとは同期しない。ブラウザ保存、Cookie、API、WebSocketを使わず、再読み込みすると導入画面へ戻る。任意の`/display/:token`を発行する機能ではない。Static Spaceはディレクトリ末尾から`index.html`を自動解決しないため、公開リンクでは`index.html`まで省略しない。

処理場所は、クラウドを雲、端末内を端末の単色線画で示す。両アイコンの色、大きさ、線幅、表示枠、余白は共通にし、安全性や推奨度を示す鍵、盾、警告色、アニメーションを使用しない。

## 手動確認と自動リハーサル

トップ画面では、従来の「前へ」「次へ」による6画面の手動確認を維持する。「自動リハーサルを開始」を選ぶと、4提示を次の固定時間で自動進行し、最後に同じサマリーを表示する。

- データ取扱いの確認: 8秒
- 処理中: 3秒
- 結果提示: 15秒
- リセット: 7秒

フグ条件では、結果提示の開始から6秒かけて画面上のフグを膨張させ、結果提示の終了まで保持する。リセット開始から6秒かけて収縮させ、残り1秒は収縮状態を保つ。クラウド条件と端末内条件で右側の結果表示とフグ動作を変えない。これは画面だけの模擬動作であり、実機や装置アダプタには接続しない。

自動進行の状態とタイマーはページのメモリ内だけに置く。フォーム、研究用ID、ログ、API、WebSocket、ブラウザ保存を使用せず、再読み込み後に状態を復元しない。単体テストでは`rehearsalTimingMs`を注入でき、E2Eではブラウザ時計を進めて実時間を待たずに全工程を確認する。既定値は`PUBLIC_DEMO_REHEARSAL_TIMING_MS`に固定する。

公開ホスティング基盤は通常のサービス運用ログを保持し得る。このため、実参加者に公開URLを案内せず、表示レビューだけに使用する。本番実験は[Windowsローカル本番デプロイ](DEPLOYMENT.md)のGO判定に従う。

## ビルドと検証

```powershell
npm.cmd run build:public-demo
npm.cmd run test:public-demo
```

`dist-public-demo/`には、次の5つのHTMLと同一originの`assets/`だけが生成される。

```text
index.html
operator/index.html
display/demo/index.html
device-test/index.html
healthz/index.html
assets/
```

ビルド処理は、上記以外のHTML、フォーム、API、WebSocket、ブラウザ保存、研究用credential、ログ、装置アダプタ、内部条件コードの既知文字列を成果物から検出した場合に失敗する。`BroadcastChannel`はブラウザ内の一時的な表示番号同期だけに使用する。

## Hugging Face Static Space

配置先は`furukawa1020/sechack-experiment-demo`である。アップロード用ディレクトリには次だけを複製する。

```text
README.md
index.html
operator/index.html
display/demo/index.html
device-test/index.html
healthz/index.html
assets/
```

`README.md`は`deploy/huggingface-space/README.md`、残りは`dist-public-demo/`を使用する。デプロイスクリプトは、この許可リストと`.gitattributes`以外の古い公開ファイルを削除する。リポジトリ全体、`data/`、設定、ログ、サーバコードをアップロードしてはならない。

既存Spaceの更新には、今回のデプロイで実測済みの`HfApi.create_commit`方式を使う。スクリプトは公開対象を上記ファイルだけに制限し、`.gitattributes`以外の古い公開ファイルを削除してから単一コミットで反映する。Hugging Faceへログイン済みの環境、または`HF_TOKEN`を設定した環境で実行する。

```powershell
npm.cmd run build:public-demo
python -m venv .venv-deploy
.\.venv-deploy\Scripts\python.exe -m pip install -r .\deploy\huggingface-space\requirements.txt
.\.venv-deploy\Scripts\python.exe .\deploy\huggingface-space\deploy.py --dry-run
.\.venv-deploy\Scripts\hf.exe auth login
.\.venv-deploy\Scripts\python.exe .\deploy\huggingface-space\deploy.py
```

Space自体を新規作成する場合だけ、先にHugging Faceの画面でStatic Spaceとして作成する。リポジトリ全体を対象にする`hf upload`は使用しない。

公開URLは次である。

```text
https://furukawa1020-sechack-experiment-demo.static.hf.space/
https://furukawa1020-sechack-experiment-demo.static.hf.space/operator/index.html
https://furukawa1020-sechack-experiment-demo.static.hf.space/display/demo/index.html
https://furukawa1020-sechack-experiment-demo.static.hf.space/device-test/index.html
https://furukawa1020-sechack-experiment-demo.static.hf.space/healthz/index.html
```

2026-07-21にcommit `72e4c23dd80b31290862fefe01eb3c25045e7ce1`を配信し、許可ファイル一覧とSHA-256、配信commit、全5経路のHTTP 200、実ブラウザ描画、同一ブラウザ内の表示同期、模擬装置操作を確認した。ローカル成果物は同期非対応時の手動導線を含む5画面幅・25ケースすべて成功し、公開HTTPSへ直接実行した1366×768の5ケースもすべて成功した。この実測中の外部originへのリクエストとWebSocketはともに0件だった。

デプロイスクリプトは、更新元commitを固定した競合防止付きの単一commitで反映する。反映後は、公開commitの許可ファイル一覧とSHA-256をローカル成果物へ照合する。実配信ではHugging FaceがHTMLへSpace管理用スクリプトを注入するため、HTMLの配信bytesは原本と一致しない。そこで、配信commitを`X-Repo-Commit`で確認し、5つのHTMLは固有title・application root・ビルド済みJS/CSS参照を照合し、JS/CSSは配信bytesのSHA-256を照合する。別originへのリダイレクト、旧commit、誤ったHTML、欠落アセットは成功として扱わない。

公開後は、トップの全6画面、固定経路、1366×768と1920×1080の収まり、モバイル幅の横方向非オーバーフロー、同一ブラウザ内の表示同期、実機なし表示、入力・フォーム・QRがないこと、配信HTML・JS・CSS以外の能動的通信が発生しないことを確認する。公開デモのデプロイ成功は、本番実験のGO判定を意味しない。

画面証跡は`npm.cmd run test:public-demo`で毎回再生成する。導入、クラウド×状態ラベル、端末内×状態ラベル、クラウド×フグ、端末内×フグ、サマリーの6画面を各検証幅で保存し、レビュー進行画面と読み取り専用表示は1366×768と1920×1080で`artifacts/screenshots/`へ保存する。画像はローカルで目視確認するが、Gitおよび公開・本番成果物には含めない。古い画像を手作業で流用しない。

静的HTMLのmeta CSPには、meta配信で有効なディレクティブだけを記載する。`frame-ancestors`はHTTPレスポンスヘッダーでのみ有効なためmetaへ記載せず、ブラウザに無視される設定を安全対策として扱わない。Hugging Face SpaceではREADME front matterの`disable_embedding: true`を設定するが、直接配信される`.static.hf.space` URLのセキュリティ境界として扱わない。

2026-07-21のChromiumによる外部originからの実測では、公開中の5経路すべてがiframe内に描画された。したがって、現行配信先には厳密な埋め込み禁止がない。この制約を受け入れられるのは、公開デモが入力、認証、研究データ、フォーム導線、永続状態を一切持たず、実参加者へ使用しない表示レビュー専用だからである。厳密な埋め込み禁止が必要になった場合は、GETレスポンスへ`Content-Security-Policy: frame-ancestors 'none'`または同等のHTTPヘッダーを設定できる配信先へ移行し、外部originからのiframe描画が拒否されることを実ブラウザで確認する。
