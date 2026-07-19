# DEVICE_PROTOCOL.md — フグ型デバイス通信仕様

## 1. 方針

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

## 2. Host → Device

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

## 3. Device → Host

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

## 4. 状態

- disconnected
- connecting
- idle
- inflating
- holding
- deflating
- stopped
- fault

## 5. 安全動作

次の場合、ホストはSTOPを送る。

- ACK timeout
- invalid response
- serial disconnect
- experiment abort
- emergency stop
- participant display loss during puffer phase
- application shutdown

STOP後は可能な場合DEFLATEを送る。ただし実機のfault方針を優先する。

## 6. タイムアウト

設定例：

- PING：1000ms
- STATUS：1000ms
- INFLATE ACK：1000ms
- DEFLATE ACK：1000ms
- STOP ACK：500ms

ACKは動作完了ではなく受理を示す。完了は`status`または非同期イベントで確認する。

## 7. MockDevice

MockDeviceは同じインターフェースを実装する。

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
