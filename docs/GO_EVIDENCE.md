# EXTERNAL COMPLIANCE MODEの責務境界

対象プロトコル: `R8-010-2x2-screen-v3`

この文書は承認証跡ではなく、本システムが扱う範囲と扱わない範囲を定める運用境界である。

## 状態モデル

正式productionは次の意味を持つ状態を使用する。

```text
technicalReadiness = GO
participantMode = enabled
complianceMode = external
approvalEvidence = managed-outside-system
approvalVerifiedByApplication = false
```

- `technicalReadiness=GO`: ソフトウェア、安全停止、同意確認導線、実験進行機能の必須runtime checkが成功している
- `participantMode=enabled`: 実参加者向け進行を利用できる
- `complianceMode=external`: 倫理承認の確認と証跡管理は本システム外の責任者が行う
- `approvalEvidence=managed-outside-system`: 承認証跡は本アプリ、設定、Git、CI、manifest、ログに保管しない
- `approvalVerifiedByApplication=false`: 本アプリは倫理承認を検証したとは主張しない

Operator画面では単独の「承認済み」ではなく、次を分けて表示する。

```text
技術状態：実施可能
参加者モード：有効
承認証跡：本システム外で管理
本システムによる承認検証：実施しない
```

## 本システムへ入れないもの

次を要求、保存、送信、生成しない。

- 倫理審査承認PDF、承認文書のコピーまたは画像
- 承認文書の参照、保存場所、SHA-256
- 確認者の氏名、メールアドレス、ユーザーID、署名
- 二人目の確認者、reviewer identity、照合記録
- screen pilotの個人情報や実施件数を承認証跡として扱う記録
- manual GO ticket、承認資料のアップロード
- `APPROVED_BY_SYSTEM`その他、アプリが承認を検証したと誤解させる状態

旧`goEvidence`、承認文書、承認hash、二名照合、screen pilot件数、manual GO ticketは正式productionのrelease/startハードゲートではない。古い`PENDING`を`APPROVED`へ書き換える移行も行わない。

## アプリ内の開始条件

第1提示を開始できるのは次のすべてが成立した場合だけである。

```text
complianceMode === external
participantMode === enabled
operatorSessionConfirmation === true
consentConfirmedForParticipant === true
emergencyStopAvailable === true
requiredRuntimeChecksPassed === true
```

承認資料の存在、文書パス、承認文書ハッシュ、二名照合、screen pilot件数、manual ticketはこの判定に含めない。

## Operatorのセッション内確認

タイトル:

```text
外部管理事項と当日運用の確認
```

説明:

```text
本システムは倫理承認資料を保管・検証しません。
承認資料と実施条件の確認は、研究責任者および当日の運用責任者が
本システム外で行います。
```

確認項目:

- 本日の実施が、研究責任者から指示された手順に従っている
- 参加者が研究説明・同意フォームを完了したことを確認した
- 実験中止操作を確認した
- 実機を使用する場合、STOPおよび収縮動作を確認した

ボタン:

```text
当日の実験運用を開始する
```

この確認で氏名、メールアドレス、ID、署名、承認番号、承認文書、SHA-256を入力させない。状態はサーバメモリまたは`sessionStorage`だけに保持し、永続ログ、データベース、`localStorage`へ保存しない。アプリまたはブラウザを再起動した後は再確認を求める。

これは倫理承認の証跡ではない。当日の安全な操作手順を確認するための一時状態である。参加者ごとの同意確認もセッション内だけで扱い、氏名、メールアドレス、Googleアカウント、回答内容を取得しない。

## 安全機能

external compliance modeへの移行で、次を弱めない。

- 同意未確認時の第1提示開始拒否
- 実験中止と緊急停止
- STOPとDEFLATE
- 通信切断・画面切断・装置異常時の安全停止
- 参加者が途中で中止を申し出られる案内
- 外部runtime通信0件、分析・広告・テレメトリ0件

screen pilotは任意の品質確認として実施できる。未実施または件数0でも、それだけを理由に参加者モードを拒否しない。
