import { useEffect, useState } from "react";
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

interface TestEvent {
  readonly timestamp: string;
  readonly action: DeviceAction | "initial-status";
  readonly result: string;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("ja-JP", { hour12: false });
}

export function DeviceTestScreen(): React.JSX.Element {
  const [device, setDevice] = useState<DeviceStatus>(EMPTY_DEVICE_STATUS);
  const [pending, setPending] = useState<DeviceAction | null>(null);
  const [events, setEvents] = useState<readonly TestEvent[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void experimentApi.getDeviceStatus().then((status) => {
      if (!current) return;
      setDevice(status);
      setEvents([{ timestamp: nowLabel(), action: "initial-status", result: status.state }]);
    }).catch((error: unknown) => {
      if (current) setFailure(errorMessage(error));
    });
    return () => { current = false; };
  }, []);

  const perform = async (action: DeviceAction): Promise<void> => {
    setPending(action);
    setFailure(null);
    try {
      const status = await experimentApi.deviceAction(action);
      setDevice(status);
      setEvents((current) => [
        ...current,
        { timestamp: nowLabel(), action, result: status.fault ?? status.state },
      ].slice(-30));
    } catch (error) {
      const message = errorMessage(error);
      setFailure(message);
      setEvents((current) => [...current, { timestamp: nowLabel(), action, result: message }].slice(-30));
    } finally {
      setPending(null);
    }
  };

  const normalActions: readonly DeviceAction[] = ["connect", "ping", "status", "inflate", "deflate", "disconnect"];
  const deviceIsBusy = pending !== null;

  return (
    <div className="device-test-app" data-testid="device-test-app" data-surface="device-test" aria-busy={deviceIsBusy}>
      <header className="device-test-header">
        <div>
          <p className="operator-kicker">PUFFER DEVICE · ISOLATED TEST</p>
          <h1>デバイステスト</h1>
          <p>本番セッションとは分離された接続・安全動作確認画面です。</p>
        </div>
        <a className="secondary-button" href="/operator">実験進行コンソールへ戻る</a>
      </header>

      {failure === null ? null : <div className="operator-banner is-failure" role="alert">{failure}</div>}

      <main className="device-test-layout">
        <section className="device-status-hero" aria-labelledby="device-state-title">
          <div className="device-illustration" aria-hidden="true">
            <span className={`device-puffer state-${device.state}`} />
            <i /><i /><i />
          </div>
          <div>
            <p className="device-mode-badge">{device.mode === "mock" ? "MOCK DEVICE" : device.mode.toUpperCase()}</p>
            <h2 id="device-state-title">{device.state}</h2>
            <dl className="device-hero-details">
              <div><dt>接続</dt><dd>{device.connected ? "接続済み" : "未接続"}</dd></div>
              <div><dt>正規化レベル</dt><dd>{device.level === null ? "—" : device.level.toFixed(2)}</dd></div>
              <div><dt>異常</dt><dd>{device.fault ?? "なし"}</dd></div>
            </dl>
          </div>
        </section>

        <section className="device-command-card" aria-labelledby="command-title">
          <div className="card-heading compact-heading"><div><p>COMMANDS</p><h2 id="command-title">動作確認</h2></div></div>
          <p className="command-note">膨張テストはサーバー設定の正規化レベルと安全上限を使用します。物理圧力は指定できません。</p>
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
            onClick={() => { void perform("stop"); }}
            disabled={deviceIsBusy}
          >
            <span>STOP</span><small>最優先で停止命令を送信</small>
          </button>
        </section>

        <section className="device-event-card" aria-labelledby="device-events-title">
          <div className="card-heading compact-heading"><div><p>ACK / STATUS</p><h2 id="device-events-title">コマンド履歴</h2></div></div>
          {events.length === 0 ? <p className="empty-events">まだコマンドはありません</p> : (
            <ol className="device-event-list">
              {[...events].reverse().map((event, index) => (
                <li key={`${event.timestamp}-${event.action}-${index}`}>
                  <time>{event.timestamp}</time>
                  <strong>{event.action === "initial-status" ? "初期状態" : ACTION_LABELS[event.action]}</strong>
                  <span>{event.result}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
