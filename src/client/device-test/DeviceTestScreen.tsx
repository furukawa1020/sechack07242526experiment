import { useEffect, useState, type CSSProperties } from "react";
import { experimentApi, errorMessage } from "../shared/api.js";
import { EMPTY_DEVICE_STATUS, type DeviceStatus } from "../shared/model.js";

type DeviceAction = "connect" | "disconnect" | "ping" | "status" | "inflate" | "deflate" | "stop";

const ACTION_LABELS: Readonly<Record<DeviceAction, string>> = {
  connect: "接続",
  disconnect: "切断",
  ping: "PING",
  status: "STATUS",
  inflate: "膨張テスト",
  deflate: "収縮",
  stop: "STOP",
};

const DEVICE_MODE_LABELS: Readonly<Record<DeviceStatus["mode"], string>> = {
  mock: "Mock（本番不可）",
  serial: "Serial実機",
  screen: "画面上のフグ・実機なし正式方式",
  unknown: "未確認",
};

interface TestEvent {
  readonly timestamp: string;
  readonly action: DeviceAction | "initial-status";
  readonly result: string;
  readonly requestId: string | null;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("ja-JP", { hour12: false });
}

export function DeviceTestScreen(): React.JSX.Element {
  const [device, setDevice] = useState<DeviceStatus>(EMPTY_DEVICE_STATUS);
  const [pending, setPending] = useState<DeviceAction | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [events, setEvents] = useState<readonly TestEvent[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void experimentApi.getDeviceStatus().then((status) => {
      if (!current) return;
      setDevice(status);
      setEvents([{ timestamp: nowLabel(), action: "initial-status", result: status.state, requestId: null }]);
    }).catch((error: unknown) => {
      if (current) setFailure(errorMessage(error));
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (device.mode !== "screen" || !device.connected) return undefined;
    let current = true;
    let requestPending = false;
    const refresh = (): void => {
      if (requestPending) return;
      requestPending = true;
      void experimentApi.getDeviceStatus().then((status) => {
        if (current) setDevice(status);
      }).catch((error: unknown) => {
        if (current) setFailure(errorMessage(error));
      }).finally(() => {
        requestPending = false;
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 100);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
  }, [device.connected, device.mode]);

  const perform = async (action: DeviceAction): Promise<void> => {
    setPending(action);
    setFailure(null);
    try {
      const result = await experimentApi.deviceAction(action);
      setDevice(result.status);
      setEvents((current) => [
        ...current,
        {
          timestamp: nowLabel(),
          action,
          result: result.ack === null
            ? result.status.fault ?? result.status.state
            : `${result.ack.ok ? "ACK" : "NACK"} / ${result.ack.state} / level ${result.ack.level.toFixed(2)}${result.ack.errorCode === null ? "" : ` / ${result.ack.errorCode}`}`,
          requestId: result.ack?.requestId ?? null,
        },
      ].slice(-30));
    } catch (error) {
      const message = errorMessage(error);
      setFailure(message);
      setEvents((current) => [...current, { timestamp: nowLabel(), action, result: message, requestId: null }].slice(-30));
    } finally {
      setPending(null);
    }
  };

  const normalActions: readonly DeviceAction[] = ["connect", "ping", "status", "inflate", "deflate", "disconnect"];
  const deviceIsBusy = pending !== null;
  const screenPufferScale = device.level === null
    ? 0.52
    : Math.min(1, Math.max(0.52, 0.52 + (device.level * 0.8)));
  const screenPufferStyle = device.mode === "screen"
    ? ({ "--device-puffer-scale": String(screenPufferScale) } as CSSProperties)
    : undefined;

  const performStop = async (): Promise<void> => {
    setStopPending(true);
    setFailure(null);
    try {
      const result = await experimentApi.deviceAction("stop");
      setDevice(result.status);
      setEvents((current) => [
        ...current,
        {
          timestamp: nowLabel(),
          action: "stop" as const,
          result: result.ack === null
            ? result.status.fault ?? result.status.state
            : `${result.ack.ok ? "ACK" : "NACK"} / ${result.ack.state} / level ${result.ack.level.toFixed(2)}${result.ack.errorCode === null ? "" : ` / ${result.ack.errorCode}`}`,
          requestId: result.ack?.requestId ?? null,
        },
      ].slice(-30));
    } catch (error) {
      const message = errorMessage(error);
      setFailure(message);
      setEvents((current) => [
        ...current,
        { timestamp: nowLabel(), action: "stop" as const, result: message, requestId: null },
      ].slice(-30));
    } finally {
      setStopPending(false);
    }
  };

  return (
    <div
      className="device-test-app"
      data-testid="device-test-app"
      data-surface="device-test"
      aria-busy={deviceIsBusy || stopPending}
    >
      <header className="device-test-header">
        <div>
          <h1>{device.mode === "screen" ? "画面刺激テスト" : "デバイステスト"}</h1>
          <p>{device.mode === "screen"
            ? "本番セッションとは分離して、画面上のフグの膨張・保持・収縮を確認します。"
            : "本番セッションとは分離された接続・安全動作確認画面です。"}</p>
        </div>
        <a className="secondary-button" href="/operator">実験進行コンソールへ戻る</a>
      </header>

      {failure === null ? null : <div className="operator-banner is-failure" role="alert">{failure}</div>}

      <main className="device-test-layout">
        <section className="device-status-hero" aria-labelledby="device-state-title">
          <div className="device-illustration" aria-hidden="true">
            <span
              className={`device-puffer state-${device.state}${device.mode === "screen" ? " is-screen" : ""}`}
              style={screenPufferStyle}
              data-device-motion={device.state}
              data-device-level={device.level === null ? "unknown" : device.level.toFixed(3)}
            />
            <i /><i /><i />
          </div>
          <div>
            <div className="device-state-heading">
              <h2 id="device-state-title">{device.state}</h2>
              <p className="device-mode-badge">提示モード: {DEVICE_MODE_LABELS[device.mode]}</p>
            </div>
            <dl className="device-hero-details">
              <div><dt>接続</dt><dd>{device.connected ? "接続済み" : "未接続"}</dd></div>
              <div><dt>正規化レベル</dt><dd>{device.level === null ? "—" : device.level.toFixed(2)}</dd></div>
              <div><dt>異常</dt><dd>{device.fault ?? "なし"}</dd></div>
            </dl>
          </div>
        </section>

        <section className="device-command-card" aria-labelledby="command-title">
          <div className="card-heading compact-heading"><div><h2 id="command-title">動作確認</h2></div></div>
          <p className="command-note">{device.mode === "screen"
            ? "膨張テストは本番と同じ正規化レベル・時間で画面表示だけを動かします。物理装置への命令は送信しません。"
            : "膨張テストはサーバー設定の正規化レベルと安全上限を使用します。物理圧力は指定できません。"}</p>
          {device.mode === "screen" ? (
            <p className="device-timing-note">膨張 6秒 → 保持 ／ 収縮 6秒（サーバ時刻同期）</p>
          ) : null}
          <div className="device-command-grid">
            {normalActions.map((action) => (
              <button
                key={action}
                type="button"
                className={action === "inflate" ? "primary-button" : "secondary-button"}
                onClick={() => { void perform(action); }}
                disabled={deviceIsBusy || (action === "connect" && device.connected)}
              >
                {pending === action ? "実行中…" : ACTION_LABELS[action]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="emergency-button device-stop-button"
            onClick={() => { void performStop(); }}
            disabled={stopPending}
          >
            <span>{stopPending ? "STOP送信中…" : "STOP"}</span><small>通常コマンドを待たず最優先で送信</small>
          </button>
        </section>

        <section className="device-event-card" aria-labelledby="device-events-title">
          <div className="card-heading compact-heading"><div><h2 id="device-events-title">コマンド履歴</h2></div></div>
          {events.length === 0 ? <p className="empty-events">まだコマンドはありません</p> : (
            <ol className="device-event-list">
              {[...events].reverse().map((event, index) => (
                <li key={`${event.timestamp}-${event.action}-${index}`}>
                  <time>{event.timestamp}</time>
                  <strong>{event.action === "initial-status" ? "初期状態" : ACTION_LABELS[event.action]}</strong>
                  <span>{event.result}</span>
                  {event.requestId === null ? null : <code title="requestId">{event.requestId}</code>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
