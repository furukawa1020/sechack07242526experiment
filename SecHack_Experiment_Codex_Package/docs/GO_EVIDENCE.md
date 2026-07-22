# 本番GO証跡の作成・照合手順

対象プロトコル: `R8-010-2x2-screen-v2`

正式productionは、研究計画、倫理判断、提示開始前の同意手順、データ管理計画、画面版パイロット、および独立二名のリリース候補照合を、`config/experiment.production.json`の`goEvidence`へ結び付ける。6要件の一つでも不足すればrelease/startをhard fail-closedで拒否する。

この設定は承認そのものを作るものではない。研究責任者および所属機関が承認した文書を、非個人識別の参照情報とSHA-256で同じ設定へ拘束するためのフェイルクローズな証跡である。承認者名、メールアドレス、署名画像、外部アンケート回答、参加者情報を設定・Git・manifestへ入れてはならない。

## 1. 必要な外部証跡

承認済みの管理場所で、少なくとも次を保持する。

- `researchPlan`: 固定模擬データ、本人非測定、生体データ非取得、画面上のフグを明記した研究計画
- `ethicsDetermination`: 所属機関による倫理審査、変更審査、変更届または不要判断
- `preStimulusConsent`: 提示開始前に説明・同意を記録する承認済み手順
- `dataManagementPlan`: 研究用ID連結、アクセス権、保持期間、撤回・除外・削除の手順
- `screenPilot`: 研究チームの非参加者が、専用`screen-pilot`経路で同じ画面版プロトコルを3〜5件完走した技術パイロット記録
- `releaseVerification.reviews`: 同じ設定候補を独立に照合した二つの記録

各文書の`documentId`、`reviewId`、`reviewerCode`は、個人名ではない管理コードを使用する。`PENDING`、`TBD`、`TODO`、`EXAMPLE`、`PLACEHOLDER`、`DUMMY`、`SAMPLE`を含む仮コードと、同一文字・短い周期を繰り返した疑似SHAはGO時に拒否される。

## 2. 設定へ記録する値

承認済み文書ごとに次を記録する。

```json
{
  "status": "GO",
  "protocolVersion": "R8-010-2x2-screen-v2",
  "documentId": "PLAN-2026-001",
  "documentVersion": "1.0",
  "contentSha256": "承認済み文書の小文字64桁SHA-256",
  "approvedOn": "YYYY-MM-DD",
  "applicableUntil": "YYYY-MM-DD"
}
```

`applicableUntil`は、元文書の保存期限ではなく、その承認を今回の実施へ適用できる最終日である。未来の承認日、期限切れ、protocolVersion不一致、ゼロSHA、未記入日はすべて拒否される。

`screenPilot.completedSessions`は3〜5とする。この事前GO証跡は研究チームの非参加者による技術パイロットだけを数え、実参加者を使用しない。`npm.cmd run screen-pilot`は`ScreenPufferDevice`、正式固定値・順序・時間、loopback、外部回答送信なし、`PILOT-001`形式、`data/screen-pilot-sessions`の隔離ログ、非参加者表示を起動時に強制する。Mockリハーサル、公開レビュー、自動E2Eはこの件数へ含めない。実参加者による追加パイロットが研究計画上必要な場合は、初回production GOの後に承認済み手順で別途実施し、この事前技術パイロットで代替しない。

`screenPilot`には管理票の参照情報に加え、実施時に記録した`sourceTreeSha256`と`pilotConfigFileHash`を必須で記録する。`sourceTreeSha256`はscreen-pilot起動時の同名値、`pilotConfigFileHash`は起動時の`configFileHash`である。ゼロ値や反復疑似SHAは拒否され、`screenPilot.sourceTreeSha256`が`releaseVerification.sourceTreeSha256`と一致しない場合もGOにならない。productionリリース生成は、候補commitの固定パス`config/experiment.screen-pilot.json`を直接読み、そのバイトSHA-256が`pilotConfigFileHash`と一致することを再検証する。

二名照合では、異なる`reviewId`、`reviewerCode`、`attestationSha256`を使用し、同じ`criticalConfigSha256`、`appVersion`、`sourceTreeSha256`、protocolVersion、照合版を確認する。二件の照合版は一致させ、照合日は実施日の30日前以内とする。氏名と署名は承認済みの外部管理票だけへ記録する。

### 非参加者screen-pilotの実施経路

1. 必須5テストが成功した候補をcommitし、Git worktreeのルートで`git status --short --untracked-files=all`が空であることを確認して`npm.cmd run screen-pilot`を実行する。このコマンドは毎回再ビルドし、worktreeルート、cleanなHEAD、固定pilot設定のGit追跡とHEADバイト完全一致を再検証する。`node dist-server/screen-pilot.js`の直接実行や、既存・コピー済み`dist-server/`の流用は承認経路に含めない。
2. Operatorに「非参加者用の事前確認」「画面版・PILOT/テスト」、参加者側表示に「非参加者用の事前確認」「外部回答送信なし」が常設され、外部回答導線がないことを確認する。
3. 氏名等を使わず、異なる`PILOT-xxx`を用いて3〜5件を完走する。研究参加者、正式`SH26-xxx`、外部回答を使用しない。
4. 起動時に表示された`sourceCommit`、`sourceTreeSha256`、`configFileHash`を保存し、各対象JSONLイベントの同名3フィールドが完全一致することを確認する。外部の承認済み管理票へ、この3値、完走した非個人識別ID、終了状態、対象JSONLのSHA-256、確認日を記録する。JSONLや個人情報をGit、設定、manifestへ転記しない。
5. その管理票の版とSHA-256に加え、記録済み`sourceTreeSha256`を`screenPilot.sourceTreeSha256`へ、記録済み`configFileHash`を`screenPilot.pilotConfigFileHash`へ転記する。protocolVersion、固定値、文言、提示時間、順序、ScreenPufferDevice動作、pilot設定またはproduction設定以外の追跡ファイルを変更した場合は旧記録を流用せず、3〜5件を再実施する。

この経路は初回GO前の循環を解く非参加者技術確認であり、人対象研究のproduction、同意取得、外部回答、正式データ収集には使用できない。正式リリースにも`screen-pilot`起動ファイルを同梱しない。

## 3. SHA-256の結合

preflightは、`goEvidence`を除く正式設定全体からcanonicalな`criticalConfigSha256`を算出する。これにより自己参照を避けながら、空の`formUrl`、不在の`formAudit`、固定値、提示時間、順序、screenモード、ログ先、`127.0.0.1`限定と外部runtime通信禁止を同じ承認候補へ拘束する。

`goEvidence`全体は別の`goEvidenceSha256`へまとめる。production manifestは次を同時に封印する。

- 設定ファイルのバイトSHA-256と意味SHA-256
- `criticalConfigSha256`
- `goEvidenceSha256`
- 実際のcleanなGit source commit
- `config/experiment.production.json`だけを除外したGit HEADの全追跡treeの`sourceTreeSha256`
- Git HEADで追跡された`package.json.version`である`appVersion`
- source commit、source tree、appVersion、対象設定、GO証跡のbinding SHA-256

production manifest schema version 4はこれらを同時に拘束する。production設定だけをsource treeから除外するのは、設定自身へ`sourceTreeSha256`を記録する際の自己参照を避けるためである。似た名前のバックアップ、未使用コード、文書、lockfileを含む他の全追跡entryは除外されない。設定、証跡、appVersion、追跡source tree、source commitのいずれかが変われば、リリース生成または起動時照合が失敗する。binding SHA-256は電子署名の代替ではない。生成後のmanifest SHA-256は、二名が承認済み管理票へ別経路で記録する。

screen-pilotとproduction候補は同じsource tree定義を使用する。どちらも固定production設定だけを除外し、固定pilot設定を含む他の全追跡entryを対象にする。このため、パイロット後に承認値をproduction設定へ書き戻す操作だけではdigestが循環せず、コード、文書、lockfile、pilot設定などを一つでも変えれば一致が失われる。`pilotConfigFileHash`はこのtree拘束に加えて、実施時とリリース候補の固定pilot設定バイトが同一であることを直接拘束する。

## 4. GO化の順序

1. 専用経路で非参加者screen-pilotを3〜5件完走し、外部管理票を確定する。
2. 研究計画、倫理判断、提示前同意、データ管理計画、screen pilot、独立二名reviewの6種類の外部証跡を確定し、文書SHA-256と適用期限を確認する。
3. production設定の`formUrl`が空で`formAudit`が存在せず、外部runtime通信が禁止されていることを確認する。外部アンケートの準備・告知・運用はこの手順に混ぜない。
4. production設定を含む候補一式をcommitし、`git status --short`が空であることを確認する。
5. `npm.cmd run release:source-evidence`を実行する。この読取り専用コマンドが表示する`appVersion`、`criticalConfigSha256`、`pilotConfigFileHash`、`sourceTreeSha256`、`sourceCommit`を照合候補として保存する。
6. `criticalConfigSha256`を`goEvidence`の対象欄へ、`appVersion`と`sourceTreeSha256`を`releaseVerification`へ転記する。さらに同じ`sourceTreeSha256`を`screenPilot.sourceTreeSha256`へ、`pilotConfigFileHash`を`screenPilot.pilotConfigFileHash`へ転記する。二名はこれらの値と候補sourceを独立に照合し、実際の承認後に限り各`status`を`GO`へ変更する。
7. 最終的なproduction設定だけをcommitし、再度`npm.cmd run release:source-evidence`を実行する。production設定だけの変更では`sourceTreeSha256`と`pilotConfigFileHash`は変わらない。`appVersion`、`criticalConfigSha256`、`sourceTreeSha256`、`pilotConfigFileHash`の全一致を確認し、最終`sourceCommit`を記録する。一つでも変わった場合は照合をやり直す。
8. `npm.cmd run preflight -- --config config/experiment.production.json`を実行する。
9. 必須5テストとproductionリリース生成を実行し、別の二名が生成済みmanifest schema version 4、source commit、source tree SHA-256、appVersion、config SHA-256、GO evidence SHA-256を照合する。productionでは既存buildの再利用と依存導入の省略を拒否する。

フラグだけを先に変更してはならない。外部証跡、日付、SHA-256、独立照合の一つでも不足する場合は`NO-GO`を維持する。

## 5. 現在の状態

リポジトリ内のproduction設定は、未完了項目を`NO-GO`、`PENDING`、`null`、ゼロSHAとして明示している。これは安全な初期状態であり、研究責任者・所属機関・screen pilot実施者・二名照合者の実作業なしに自動解除しない。v1用のフォーム監査はv2のGO証跡やrelease/start gateではない。
