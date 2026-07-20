# 本番リリース二名照合票

この票はアプリへ入力せず、研究計画で承認された管理方法で保管します。実参加者の氏名・回答・生体情報は記入しません。

## リリース識別

- リリースディレクトリ名:
- Git commit:
- appVersion:
- protocolVersion:
- 生成日時:
- Windows版・アーキテクチャ:
- Node.js版:
- 設定ファイルSHA-256:
- 設定内容SHA-256:

## ソフトウェア

- [ ] `npm run lint`成功
- [ ] `npm run typecheck`成功
- [ ] `npm test`成功
- [ ] `npm run test:e2e`成功
- [ ] `npm run build`成功
- [ ] `VERIFY_RELEASE.cmd`成功
- [ ] `START_PRODUCTION.cmd`の本番preflight成功
- [ ] `CHECK_HEALTH.cmd`のappVersion、protocolVersion、config hash、deviceMode一致
- [ ] リリース内にJSONL、CSV、`.env`、src、tests、Mock/E2E設定がない

## データ・ネットワーク

- [ ] `allowExternalRuntimeRequests=false`
- [ ] リリースと`data/`がOneDrive等の同期対象外
- [ ] BitLocker等でローカルディスクを暗号化
- [ ] コード・設定は不用意に変更できないACL
- [ ] `data/`は実験用アカウントだけが書込み可能
- [ ] 隔離LANまたは単一PC構成
- [ ] LAN時は特定インターフェースとWindows Firewallを確認
- [ ] Operator tokenを写真・ログ・チャットへ保存していない

## 研究・フォーム

- [ ] 固定模擬データ方式が承認済み計画と一致
- [ ] UI_COPYと実画面を照合
- [ ] A/B右表示およびC/D右表示・装置動作の同一性を確認
- [ ] Googleフォームの研究説明・同意・11問を照合
- [ ] Googleフォームで氏名・メール等を収集しない
- [ ] QRとリンクが承認済みフォームを開く

## 実機

- [ ] Serialモードと実COMポート一致
- [ ] PING・STATUS成功
- [ ] 最大上限と物理緊急停止を確認
- [ ] 6秒膨張・保持・6秒収縮を確認
- [ ] DEFLATE後に`idle`・level 0・faultなしを確認
- [ ] ACK timeout・USB切断・faultで安全停止
- [ ] 停電・PC断で実機単体の排気が動作
- [ ] 空気漏れ・異音・異臭・過熱なし

## 承認

- 照合者1・日時:
- 照合者2・日時:
- 研究責任者の最終承認・日時:
