# DEVICE_PROTOCOL.md — 画面上フグと将来の物理フグの境界仕様

## 1. プロトコル範囲

`R8-010-2x2-screen-v1`の正式MVPは`device.mode=screen`を使用し、参加者画面内のフグだけを動かす。USBシリアル機器を接続せず、デバイス制御のための外部通信も行わない。

モードは次のように分離する。

- `screen`：正式MVP用。障害注入を持たない`ScreenPufferDevice`と画面描画
- `mock`：開発、自動テスト、明示的な模擬リハーサル専用。障害注入が可能
- `serial`：物理フグ用。将来の別プロトコルでのみ使用

`mock`を正式実施の代替として使用してはならない。`serial`を`R8-010-2x2-screen-v1`へ混在させてはならない。物理フグと画面上フグの切替は研究刺激の変更であるため、研究責任者の承認と、所属機関で必要な倫理審査・変更手続きを完了してから別プロトコルとして実施する。

## 2. ScreenPufferDevice

`ScreenPufferDevice`は共通の`PufferDevice`インターフェースを実装するインプロセスの状態アダプタである。`connect`、`ping`、`status`、`inflate`、`deflate`、`stop`はローカルメモリ上の状態だけを変更し、USB、ネットワーク、外部APIへ命令を送らない。

正式動作は次で固定する。

1. CまたはDの`result`開始と同じサーバ時刻に、`level=0.60`、`rampMs=6000`の膨張を開始する。
2. 画面上のフグは6,000msで同じ目標形状まで膨張する。
3. 膨張完了後は`result`終了まで同じ形状を保持する。
4. `reset`開始と同じサーバ時刻に、`rampMs=6000`の収縮を開始する。
5. 画面上のフグは6,000msで初期形状へ戻る。7,000msの`reset`終了までに収縮済みであることを確認する。

CとDで命令列、目標レベル、開始時刻、描画、膨張速度、保持時間、収縮速度を完全に同一にする。異なるのは左パネルのデータ取扱い説明だけである。

サーバを唯一の時刻源とし、スナップショットにフェーズ開始時刻、終了予定時刻、サーバ現在時刻および画面フグ状態を含める。参加者画面はその時刻差から進捗を描画し、クライアント固有のタイマーだけで状態を決定しない。継続接続中の再描画は経過分を反映した同じ進捗から描画する。`result`または`reset`中の再読み込み・切断は刺激欠損なので、復元・再開せず安全停止する。他フェーズの再読み込みでは進行を止め、再接続後にOperatorが確認した場合だけ残り時間から再開する。

中断、緊急停止、参加者画面喪失またはアプリ終了時は`stop`、続けて`deflate`を状態機械上で試行し、中立な中断画面へ移る。

## 3. 共通デバイス抽象化

`ScreenPufferDevice`、`MockPufferDevice`、将来の`SerialPufferDevice`は同じ操作境界を実装する。ただし、正式MVPの画面描画はサーバのフェーズ時刻と公開スナップショットを正とし、クライアントから状態変更命令を受け付けない。

## 4. 将来のSerialPufferDeviceの方針

以下は将来の物理フグ版で維持する通信・安全要件であり、`R8-010-2x2-screen-v1`の正式実施では使用しない。

- USBシリアルを想定する
- 改行区切りUTF-8 JSON
- 1コマンド1ACK
- すべてのコマンドに`requestId`
- 実機側が安全上限を強制
- アプリは物理圧力を直接指定しない
- `level`は0.0〜1.0の正規化値
- STOPは他のすべてより優先
- 不明コマンドは拒否
- 通信断時、実機側も安全停止することが望ましい

## 5. Host → Device

### PING

```json
{"v":1,"requestId":"uuid","cmd":"ping"}
```

### STATUS

```json
{"v":1,"requestId":"uuid","cmd":"status"}
```

### INFLATE

```json
{"v":1,"requestId":"uuid","cmd":"inflate","level":0.6,"rampMs":6000}
```

### DEFLATE

```json
{"v":1,"requestId":"uuid","cmd":"deflate","rampMs":6000}
```

### STOP

```json
{"v":1,"requestId":"uuid","cmd":"stop"}
```

## 6. Device → Host

### ACK

```json
{
  "v":1,
  "requestId":"uuid",
  "ok":true,
  "state":"inflating"
}
```

### STATUS response

```json
{
  "v":1,
  "requestId":"uuid",
  "ok":true,
  "state":"idle",
  "level":0.0,
  "fault":null
}
```

### ERROR

```json
{
  "v":1,
  "requestId":"uuid",
  "ok":false,
  "state":"fault",
  "errorCode":"OVERPRESSURE"
}
```

### 非同期イベント

```json
{"v":1,"event":"ready","state":"idle","level":0.0}
```

```json
{"v":1,"event":"fault","state":"fault","errorCode":"OVERPRESSURE"}
```

## 7. 状態

- disconnected
- connecting
- idle
- inflating
- holding
- deflating
- stopped
- fault

## 8. 物理フグの安全動作

次の場合、ホストはSTOPを送る。

- ACK timeout
- invalid response
- serial disconnect
- experiment abort
- emergency stop
- participant display loss during puffer phase
- application shutdown

STOP後は可能な場合DEFLATEを送る。ただし実機のfault方針を優先する。

## 9. 物理フグのタイムアウト

設定例：

- PING：1000ms
- STATUS：1000ms
- INFLATE ACK：1000ms
- DEFLATE ACK：1000ms
- STOP ACK：500ms

ACKは動作完了ではなく受理を示す。完了は`status`または非同期イベントで確認する。

## 10. MockDevice

MockDeviceは同じインターフェースを実装するが、開発、自動テストおよび明示的な模擬リハーサル専用とする。正式実施用の`screen`とは別モードであり、正式実施では起動を拒否する。

機能：

- 正常動作
- ACK delay
- ACK timeout
- disconnect
- fault
- inflate/deflate state
- 実時間/高速時間
- コマンド履歴

CとDに送られたコマンド列が一致することをテストできるようにする。
