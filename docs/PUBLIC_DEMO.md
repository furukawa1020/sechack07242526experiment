# 公開Mockデモの配布と確認

## 用途と禁止事項

公開Mockデモは、固定模擬データによる画面表示だけをブラウザで確認する静的サイトである。研究参加、参加同意、回答収集、実機制御には使用しない。

公開成果物には、研究用ID入力、Operator画面、参加者token、REST API、WebSocket、ログ、CSV、装置アダプタ、USBシリアル通信、回答フォーム、QRコード、分析、テレメトリ、外部CDN、外部フォントを含めない。「クラウド」は比較用シナリオの表示文言だけであり、外部へ身体データを送信しない。

処理場所は、クラウドを雲、端末内を端末の単色線画で示す。両アイコンの色、大きさ、線幅、表示枠、余白は共通にし、安全性や推奨度を示す鍵、盾、警告色、アニメーションを使用しない。

公開ホスティング基盤は通常のサービス運用ログを保持し得る。このため、実参加者に公開URLを案内せず、表示レビューだけに使用する。本番実験は[Windowsローカル本番デプロイ](DEPLOYMENT.md)のGO判定に従う。

## ビルドと検証

```powershell
npm.cmd run build:public-demo
npm.cmd run test:public-demo
```

`dist-public-demo/`には`index.html`と`assets/`だけが生成される。ビルド処理は、フォーム、API、WebSocket、ブラウザ保存、研究用credential、ログ、装置アダプタ、内部条件コードの既知文字列を成果物から検出した場合に失敗する。

## Hugging Face Static Space

配置先は`furukawa1020/sechack-experiment-demo`である。アップロード用ディレクトリには次だけを複製する。

```text
README.md
index.html
assets/
```

`README.md`は`deploy/huggingface-space/README.md`、残りは`dist-public-demo/`を使用する。リポジトリ全体、`data/`、設定、ログ、サーバコードをアップロードしてはならない。

既存Spaceの更新には、今回のデプロイで実測済みの`HfApi.create_commit`方式を使う。スクリプトは公開対象を上記ファイルだけに制限し、`.gitattributes`以外の古い公開ファイルを削除してから単一コミットで反映する。Hugging Faceへログイン済みの環境、または`HF_TOKEN`を設定した環境で実行する。

```powershell
npm.cmd run build:public-demo
py -3.11 -m venv .venv-deploy
.\.venv-deploy\Scripts\python.exe -m pip install -r .\deploy\huggingface-space\requirements.txt
.\.venv-deploy\Scripts\python.exe .\deploy\huggingface-space\deploy.py --dry-run
hf auth login
.\.venv-deploy\Scripts\python.exe .\deploy\huggingface-space\deploy.py
```

Space自体を新規作成する場合だけ、先にHugging Faceの画面でStatic Spaceとして作成する。リポジトリ全体を対象にする`hf upload`は使用しない。

公開URLは次である。

```text
https://furukawa1020-sechack-experiment-demo.static.hf.space/
```

公開後は全6画面、1366×768と1920×1080の収まり、実機なし表示、入力・フォーム・QRがないこと、HTML・JS・CSS以外の通信が発生しないことを確認する。公開デモのデプロイ成功は、本番実験のGO判定を意味しない。

画面証跡は`npm.cmd run test:public-demo`で毎回再生成する。導入、クラウド×状態ラベル、端末内×状態ラベル、クラウド×フグ、端末内×フグ、サマリーの6画面を、1366×768と1920×1080で`artifacts/screenshots/`へ保存する。古い画像を手作業で流用しない。

静的HTMLのmeta CSPには、meta配信で有効なディレクティブだけを記載する。`frame-ancestors`はHTTPレスポンスヘッダーでのみ有効なためmetaへ記載せず、ブラウザに無視される設定を安全対策として扱わない。Hugging Face SpaceではREADME front matterの`disable_embedding: true`を設定する。この公開デモには入力、認証、研究データ、フォーム導線を含めない。厳密なHTTPヘッダーによる埋め込み禁止が必要な別配信先では、ホスティング側のGETレスポンスへ`Content-Security-Policy: frame-ancestors 'none'`を設定して確認する。
