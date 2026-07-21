---
title: SecHack 実験提示UI 公開模擬デモ
emoji: 🐡
colorFrom: blue
colorTo: gray
sdk: static
app_file: index.html
pinned: false
fullWidth: true
header: mini
disable_embedding: true
short_description: 実機・入力・保存を使わないSecHack365実験提示UIの公開模擬デモ
---

# SecHack365実験提示UI・公開模擬デモ

固定模擬データを使って表示UIを確認するための静的デモです。研究参加用の本番システムではありません。

- フグ実機やUSBシリアル機器に接続しません。
- 研究用ID、氏名、メールアドレス、回答、身体データを入力・収集・保存しません。
- API、WebSocket、データベース、分析、テレメトリ、外部フォントを使いません。
- 回答フォームを表示、取得、送信しません。
- 画面内の「クラウド」は比較用シナリオであり、身体データを外部送信しません。
- `/operator/index.html`と`/display/demo/index.html`の連動は、同一ブラウザ内の一時的な表示レビューだけです。別端末同期や正式な参加者tokenではありません。
- `/device-test/index.html`は画面上の模擬状態だけを変え、USBシリアルや実機へ命令しません。

公開ホスティング事業者の通常のアクセスログの対象にはなり得るため、このSpaceを実参加者による研究手順に使用しないでください。
