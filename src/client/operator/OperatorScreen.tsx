import { useCallback, useEffect, useMemo, useState } from "react";
import { experimentApi, errorMessage, getOperatorToken } from "../shared/api.js";
import {
  EMPTY_DEVICE_STATUS,
  parseDeviceStatus,
  parseOperatorSnapshot,
  type ConditionCode,
  type DeviceStatus,
  type ExperimentPhase,
  type OperatorSnapshot,
  type OrderCode,
  type PresentationMode,
  type ProcessingLocation,
} from "../shared/model.js";
import { useRealtime, useRemainingSeconds, type RealtimeStatus } from "../shared/realtime.js";

const ORDER_OPTIONS: readonly OrderCode[] = ["ABDC", "BCAD", "CDBA", "DACB"];
const DEFAULT_RESEARCH_ID_PATTERN = "^SH26-[0-9]{3}$";
const SESSION_STORAGE_KEY = "sechack.active-session-id";

const PHASE_LABELS: Readonly<Record<ExperimentPhase, string>> = {
  idle: "待機中",
  setup: "セットアップ",
  intro: "共通導入",
  handling: "データ取扱いの確認",
  processing: "処理中",
  result: "結果提示",
  reset: "リセット",
  summary: "サマリー",
  completed: "完了",
  aborted: "中止",
  error: "エラー",
  recovery: "復旧確認待ち",
};

const DEVICE_MODE_LABELS: Readonly<Record<DeviceStatus["mode"], string>> = {
  mock: "模擬装置",
  serial: "実機（シリアル接続）",
  unknown: "未確認",
};

const DEVICE_STATE_LABELS: Readonly<Record<DeviceStatus["state"], string>> = {
  disconnected: "未接続",
  connecting: "接続中",
  idle: "待機・収縮済み",
  inflating: "膨張中",
  holding: "膨張保持中",
  deflating: "収縮中",
  stopped: "停止済み",
  fault: "異常停止",
  unknown: "未確認",
};

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "session.created": "セッションを作成",
  "session.resumed": "セッションを再開",
  "session.deleted": "セッションを削除",
  "session.completed": "セッションを完了",
  "session.aborted": "実験を中止",
  "session.error": "セッションで異常を検知",
  "session.recoveryRequired": "復旧確認が必要",
  "display.ready": "参加者画面の準備完了",
  "display.disconnected": "参加者画面が切断",
  "device.connect.issued": "装置へ接続を指示",
  "device.connect.ack": "装置接続を確認",
  "device.disconnect.issued": "装置へ切断を指示",
  "device.disconnect.ack": "装置切断を確認",
  "device.ping.issued": "装置へ応答確認を送信",
  "device.ping.ack": "装置の応答を確認",
  "device.inflate.issued": "装置へ膨張を指示",
  "device.inflate.ack": "膨張指示の受理を確認",
  "device.deflate.issued": "装置へ収縮を指示",
  "device.deflate.ack": "収縮指示の受理を確認",
  "device.deflate.complete": "装置の収縮完了を確認",
  "device.stop.issued": "装置へ停止を指示",
  "device.stop.ack": "停止指示の受理を確認",
  "device.status": "装置状態を更新",
  "device.safetyCommandFailed": "安全停止命令に失敗",
};

const PROCESSING_LABELS: Readonly<Record<ProcessingLocation, string>> = {
  cloud: "クラウド",
  local: "この端末内",
};

const PRESENTATION_LABELS: Readonly<Record<PresentationMode, string>> = {
  label: "状態ラベル",
  puffer: "フグのふくらみ",
};

const CONDITION_LABELS: Readonly<Record<ConditionCode, string>> = {
  A: "クラウド × 状態ラベル",
  B: "この端末内 × 状態ラベル",
  C: "この端末内 × フグのふくらみ",
  D: "クラウド × フグのふくらみ",
};

function connectionLabel(status: RealtimeStatus): string {
  if (status === "open") return "接続済み";
  if (status === "connecting") return "接続中";
  return "切断・再接続待ち";
}

function deviceLabel(device: DeviceStatus): string {
  return `${DEVICE_MODE_LABELS[device.mode]} / ${DEVICE_STATE_LABELS[device.state]}`;
}

function eventLabel(type: string): string {
  if (type.startsWith("phase.")) {
    const phase = type.slice("phase.".length);
    if (phase in PHASE_LABELS) return `フェーズ: ${PHASE_LABELS[phase as ExperimentPhase]}`;
  }
  return EVENT_LABELS[type] ?? "システムイベント";
}

function eventDetail(detail: string): string {
  if (detail in DEVICE_STATE_LABELS) return DEVICE_STATE_LABELS[detail as DeviceStatus["state"]];
  return detail;
}

interface StatusItemProps {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly emphasis?: boolean;
}

function StatusItem({ label, value, emphasis = false }: StatusItemProps): React.JSX.Element {
  return (
    <div className={emphasis ? "operator-status-item is-emphasis" : "operator-status-item"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SetupForm({
  researchId,
  consentConfirmed,
  automaticOrder,
  manualOrder,
  researchIdPattern,
  isMock,
  busy,
  onResearchId,
  onConsent,
  onAutomaticOrder,
  onManualOrder,
  onSubmit,
}: {
  readonly researchId: string;
  readonly consentConfirmed: boolean;
  readonly automaticOrder: boolean;
  readonly manualOrder: OrderCode;
  readonly researchIdPattern: string;
  readonly isMock: boolean;
  readonly busy: boolean;
  readonly onResearchId: (value: string) => void;
  readonly onConsent: (value: boolean) => void;
  readonly onAutomaticOrder: (value: boolean) => void;
  readonly onManualOrder: (value: OrderCode) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}): React.JSX.Element {
  const validId = useMemo(() => new RegExp(researchIdPattern, "u").test(researchId), [researchId, researchIdPattern]);
  return (
    <form className="operator-card setup-form" onSubmit={onSubmit}>
      <div className="card-heading">
        <span className="step-number">1</span>
        <div><h2>{isMock ? "模擬リハーサル" : "参加者セッション"}</h2></div>
      </div>
      <label className="field-label" htmlFor="research-id">研究用ID</label>
      <input
        id="research-id"
        name="researchId"
        value={researchId}
        onChange={(event) => onResearchId(event.target.value.toUpperCase())}
        placeholder="研究用ID"
        pattern={researchIdPattern}
        autoComplete="off"
        spellCheck={false}
        aria-describedby="research-id-hint"
        required
      />
      <p id="research-id-hint" className={researchId.length > 0 && !validId ? "field-hint is-error" : "field-hint"}>
        設定形式: {researchIdPattern}（氏名やメールアドレスは入力しないでください）
      </p>

      <label className="check-row">
        <input
          type="checkbox"
          checked={consentConfirmed}
          onChange={(event) => onConsent(event.target.checked)}
        />
        <span>
          <strong>{isMock ? "リハーサル開始条件を確認済み" : "Googleフォームでの同意を確認済み"}</strong>
          <small>{isMock ? "実参加者・実回答には使用しません" : "口頭確認だけでは開始しません"}</small>
        </span>
      </label>

      <fieldset className="order-fieldset">
        <legend>提示順の割付</legend>
        <label>
          <input
            type="radio"
            name="orderMode"
            checked={automaticOrder}
            onChange={() => onAutomaticOrder(true)}
          />
          自動割付
        </label>
        <label>
          <input
            type="radio"
            name="orderMode"
            checked={!automaticOrder}
            onChange={() => onAutomaticOrder(false)}
          />
          手動選択
        </label>
        <select
          aria-label="手動の提示順"
          value={manualOrder}
          disabled={automaticOrder}
          onChange={(event) => onManualOrder(event.target.value as OrderCode)}
        >
          {ORDER_OPTIONS.map((order) => <option key={order} value={order}>{order}</option>)}
        </select>
        {!automaticOrder ? <p className="operator-warning">手動選択は提示順の偏りにつながるため、理由を運用記録へ残してください。</p> : null}
      </fieldset>

      <button className="primary-button" type="submit" disabled={busy || !validId || !consentConfirmed}>
        {isMock ? "リハーサルを準備" : "セッションを準備"}
      </button>
    </form>
  );
}

function SessionOverview({
  session,
  remainingSeconds,
  realtimeStatus,
}: {
  readonly session: OperatorSnapshot;
  readonly remainingSeconds: number | null;
  readonly realtimeStatus: RealtimeStatus;
}): React.JSX.Element {
  const condition = session.conditionCode;
  return (
    <section className="operator-card session-overview" aria-labelledby="session-overview-title">
      <div className="card-heading">
        <span className="step-number">2</span>
        <div><h2 id="session-overview-title">進行状況</h2></div>
      </div>
      <dl className="operator-status-grid">
        <StatusItem label="研究用ID" value={session.researchId} />
        <StatusItem label="提示順" value={session.orderCode} />
        <StatusItem label="現在フェーズ" value={PHASE_LABELS[session.phase]} emphasis />
        <StatusItem
          label="提示位置"
          value={session.sequenceIndex === null ? "—" : `${session.sequenceIndex + 1} / 4`}
        />
        <StatusItem label="内部条件" value={condition ?? "—"} />
        <StatusItem label="条件内容" value={condition === null ? "—" : CONDITION_LABELS[condition]} />
        <StatusItem label="処理場所" value={session.condition === null ? "—" : PROCESSING_LABELS[session.condition.processing]} />
        <StatusItem label="伝え方" value={session.condition === null ? "—" : PRESENTATION_LABELS[session.condition.presentation]} />
        <StatusItem label="残り時間" value={remainingSeconds === null ? "—" : `${remainingSeconds} 秒`} emphasis />
        <StatusItem label="固定スコア" value={`${session.fixedState.score} / 100`} />
        <StatusItem label="固定ラベル" value={session.fixedState.label} />
        <StatusItem label="フグ目標レベル" value={session.fixedState.pufferLevel.toFixed(2)} />
        <StatusItem label="参加者画面" value={session.displayConnected ? "接続済み" : "未接続"} />
        <StatusItem
          label="全画面表示"
          value={session.displayFullscreen === null ? "未通知" : session.displayFullscreen ? "全画面" : "通常表示"}
        />
        <StatusItem label="リアルタイム同期" value={connectionLabel(realtimeStatus)} />
        <StatusItem label="装置" value={deviceLabel(session.device)} />
        <StatusItem label="プロトコル" value={session.protocolVersion} />
        <StatusItem label="設定SHA-256" value={session.configVersion} />
        <StatusItem label="エラーコード" value={session.errorCode ?? "なし"} />
      </dl>
    </section>
  );
}

function ActionPanel({
  session,
  busy,
  emergencyPending,
  formComplete,
  fullscreenConfirmed,
  isMock,
  onFormComplete,
  onFullscreenConfirmed,
  onAction,
  onEmergency,
  onReset,
}: {
  readonly session: OperatorSnapshot;
  readonly busy: boolean;
  readonly emergencyPending: boolean;
  readonly formComplete: boolean;
  readonly fullscreenConfirmed: boolean;
  readonly isMock: boolean;
  readonly onFormComplete: (checked: boolean) => void;
  readonly onFullscreenConfirmed: (checked: boolean) => void;
  readonly onAction: (action: "prepare" | "start" | "resume" | "abort" | "confirm-form-complete") => void;
  readonly onEmergency: () => void;
  readonly onReset: () => void;
}): React.JSX.Element {
  const canAbort = !["completed", "aborted"].includes(session.phase);
  const readyForIntro = session.displayConnected
    && session.device.connected
    && session.device.state === "idle"
    && (session.device.level ?? 0) === 0
    && fullscreenConfirmed;
  return (
    <section className="operator-card action-panel" aria-labelledby="action-title">
      <div className="card-heading">
        <span className="step-number">3</span>
        <div><h2 id="action-title">進行操作</h2></div>
      </div>

      {session.displayUrl === null ? null : (
        <div className="display-url-block">
          <label htmlFor="display-url">参加者画面URL</label>
          <input id="display-url" readOnly value={session.displayUrl} />
          <a className="secondary-button" href={session.displayUrl} target="_blank" rel="noreferrer">
            参加者画面を開く
          </a>
        </div>
      )}

      <div className="action-buttons">
        {session.phase === "error" ? (
          <div className="operator-banner is-failure" role="alert">
            <strong>エラーコード: {session.errorCode ?? "UNKNOWN_ERROR"}</strong><br />
            自動再開しません。装置の物理状態を確認し、異常があれば物理緊急停止を最優先にしてください。
            安全な収縮を確認した後、「実験を中止」で中断を確定します。
          </div>
        ) : null}
        {session.phase === "setup" ? (
          <div className="prerequisite-block">
            <ul aria-label="開始条件">
              <li data-ready={session.displayConnected}>参加者画面: {session.displayConnected ? "接続済み" : "接続待ち"}</li>
              <li data-ready={session.device.connected}>装置: {session.device.connected ? "接続済み" : "接続待ち"}</li>
              <li data-ready={session.device.state === "idle"}>装置状態: {DEVICE_STATE_LABELS[session.device.state]}</li>
              <li data-ready={(session.device.level ?? 0) === 0}>収縮状態: {(session.device.level ?? 0) === 0 ? "確認済み" : "未完了"}</li>
            </ul>
            <label className="check-row compact-check">
              <input
                type="checkbox"
                checked={fullscreenConfirmed}
                onChange={(event) => onFullscreenConfirmed(event.target.checked)}
              />
              参加者画面をF11またはキオスクモードで全画面表示し、目視確認済み
            </label>
            <button type="button" className="primary-button" onClick={() => onAction("prepare")} disabled={busy || !readyForIntro}>
              共通導入を表示
            </button>
          </div>
        ) : null}
        {session.phase === "intro" ? (
          <button type="button" className="primary-button" onClick={() => onAction("start")} disabled={busy}>
            提示を開始
          </button>
        ) : null}
        {session.phase === "recovery" ? (
          <button type="button" className="primary-button" onClick={() => onAction("resume")} disabled={busy}>
            セッションを再開
          </button>
        ) : null}
        {session.phase === "summary" ? (
          <label className="check-row compact-check">
            <input type="checkbox" checked={formComplete} onChange={(event) => onFormComplete(event.target.checked)} />
            {isMock ? "リハーサルの確認を完了済み" : "Googleフォームの回答完了を確認済み"}
          </label>
        ) : null}
        {session.phase === "summary" ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => onAction("confirm-form-complete")}
            disabled={busy || !formComplete}
          >
            {isMock ? "確認を完了してリハーサル終了" : "回答完了を確認してセッション完了"}
          </button>
        ) : null}
        {session.phase === "completed" || session.phase === "aborted" ? (
          <button type="button" className="secondary-button" onClick={onReset} disabled={busy}>
            次の参加者へ
          </button>
        ) : null}
      </div>

      <div className="safety-actions">
        <button type="button" className="abort-button" onClick={() => onAction("abort")} disabled={busy || !canAbort}>
          実験を中止
        </button>
        <button
          type="button"
          className="emergency-button"
          onClick={onEmergency}
          disabled={emergencyPending}
          aria-keyshortcuts="Control+Alt+Shift+S"
        >
          <span>{emergencyPending ? "STOP送信中…" : "緊急停止"}</span>
          <small>装置を直ちにSTOP · Ctrl+Alt+Shift+S</small>
        </button>
      </div>
    </section>
  );
}

function DeviceAndEvents({
  device,
  events,
  busy,
  onConnect,
}: {
  readonly device: DeviceStatus;
  readonly events: OperatorSnapshot["recentEvents"];
  readonly busy: boolean;
  readonly onConnect: () => void;
}): React.JSX.Element {
  return (
    <aside className="operator-side-column">
      <section className="operator-card compact-card" aria-labelledby="device-status-title">
        <div className="card-heading compact-heading"><div><h2 id="device-status-title">装置状態</h2></div></div>
        <p className="device-mode-badge">装置モード: {DEVICE_MODE_LABELS[device.mode]}</p>
        <dl className="device-details">
          <StatusItem label="接続" value={device.connected ? "接続済み" : "未接続"} />
          <StatusItem label="状態" value={DEVICE_STATE_LABELS[device.state]} />
          <StatusItem label="レベル" value={device.level === null ? "—" : device.level.toFixed(2)} />
          <StatusItem label="異常" value={device.fault ?? "なし"} />
        </dl>
        <button type="button" className="secondary-button full-button" onClick={onConnect} disabled={busy || device.connected}>
          {device.mode === "mock" ? "模擬装置を準備" : "装置を接続"}
        </button>
        <a className="text-link" href="/device-test" target="_blank" rel="noreferrer">デバイステストを開く</a>
      </section>

      <section className="operator-card compact-card event-card" aria-labelledby="event-title">
        <div className="card-heading compact-heading"><div><h2 id="event-title">直近イベント</h2></div></div>
        {events.length === 0 ? <p className="empty-events">イベントはまだありません</p> : (
          <ol className="event-list">
            {[...events].reverse().map((event, index) => (
              <li key={`${event.at}-${event.type}-${index}`}>
                <time>{event.at.length === 0 ? "—" : new Date(event.at).toLocaleTimeString("ja-JP")}</time>
                <strong>{eventLabel(event.type)}<code>{event.type}</code></strong>
                {event.detail.length === 0 ? null : <span>{eventDetail(event.detail)}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

export function OperatorScreen(): React.JSX.Element {
  const [researchId, setResearchId] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [automaticOrder, setAutomaticOrder] = useState(true);
  const [manualOrder, setManualOrder] = useState<OrderCode>("ABDC");
  const [session, setSession] = useState<OperatorSnapshot | null>(null);
  const [device, setDevice] = useState<DeviceStatus>(EMPTY_DEVICE_STATUS);
  const [formComplete, setFormComplete] = useState(false);
  const [fullscreenConfirmed, setFullscreenConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emergencyPending, setEmergencyPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [researchIdPattern, setResearchIdPattern] = useState(DEFAULT_RESEARCH_ID_PATTERN);

  useEffect(() => {
    let current = true;
    void experimentApi.getOperatorConfig().then((config) => {
      if (current) setResearchIdPattern(config.researchIdPattern);
    }).catch((error: unknown) => {
      if (current) setFailure(errorMessage(error));
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const activeSessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (activeSessionId === null) return;
    let current = true;
    void experimentApi.getSession(activeSessionId).then((snapshot) => {
      if (current) setSession(snapshot);
    }).catch(() => {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void experimentApi.getDeviceStatus().then((status) => {
      if (current) setDevice(status);
    }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  const onSocketMessage = useCallback((type: string, payload: unknown): void => {
    if (type === "device.status") {
      const parsed = parseDeviceStatus(payload);
      if (parsed !== null) {
        setDevice(parsed);
        setSession((current) => current === null ? null : { ...current, device: parsed });
      }
      return;
    }
    if (type.startsWith("session.")) {
      const parsed = parseOperatorSnapshot(payload);
      if (parsed !== null) setSession(parsed);
    }
  }, []);
  const operatorSocketQuery = useMemo(() => {
    const token = getOperatorToken();
    return token === null ? "role=operator" : `role=operator&operatorToken=${encodeURIComponent(token)}`;
  }, []);
  const realtime = useRealtime({ query: operatorSocketQuery, onMessage: onSocketMessage });
  const remainingSeconds = useRemainingSeconds(session?.phaseEndsAt ?? null, session?.serverNow ?? null);

  const createSession = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFailure(null);
    setNotice(null);
    setBusy(true);
    try {
      const created = await experimentApi.createSession({
        researchId,
        consentConfirmed: true,
        orderCode: automaticOrder ? "auto" : manualOrder,
      });
      setSession(created.session);
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.session.sessionId);
      setNotice("セッションを作成しました。参加者画面と装置の状態を確認してください。");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const sessionAction = async (
    action: "prepare" | "start" | "resume" | "abort" | "confirm-form-complete",
  ): Promise<void> => {
    if (session === null) return;
    if (action === "abort" && !window.confirm("実験を中止します。セッションは再開できません。よろしいですか？")) return;
    setBusy(true);
    setFailure(null);
    try {
      const next = await experimentApi.sessionAction(session.sessionId, action);
      if (next !== null) setSession(next);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const emergencyStop = useCallback(async (): Promise<void> => {
    if (session === null) return;
    setEmergencyPending(true);
    setFailure(null);
    try {
      const next = await experimentApi.sessionAction(session.sessionId, "emergency-stop");
      if (next !== null) setSession(next);
      setNotice("緊急停止を送信しました。装置の物理状態を確認してください。");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setEmergencyPending(false);
    }
  }, [session]);

  useEffect(() => {
    const onEmergencyShortcut = (event: KeyboardEvent): void => {
      if (
        event.ctrlKey
        && event.altKey
        && event.shiftKey
        && event.code === "KeyS"
        && session !== null
        && !emergencyPending
      ) {
        event.preventDefault();
        void emergencyStop();
      }
    };
    window.addEventListener("keydown", onEmergencyShortcut);
    return () => window.removeEventListener("keydown", onEmergencyShortcut);
  }, [emergencyPending, emergencyStop, session]);

  const connectDevice = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      setDevice((await experimentApi.deviceAction("connect")).status);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resetForNext = async (): Promise<void> => {
    if (session === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await experimentApi.deleteSession(session.sessionId);
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      setSession(null);
      setResearchId("");
      setConsentConfirmed(false);
      setFormComplete(false);
      setFullscreenConfirmed(false);
      setNotice("次の参加者を受け付けられます。");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const blob = await experimentApi.exportSessionsCsv();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "experiment-sessions.csv";
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const displayedDevice = session !== null && (session.device.connected || session.device.fault !== null)
    ? session.device
    : device;
  const isMock = displayedDevice.mode === "mock";
  const events = session?.recentEvents ?? [];
  const operatorClass = useMemo(
    () => busy || emergencyPending ? "operator-app is-busy" : "operator-app",
    [busy, emergencyPending],
  );

  return (
    <div className={operatorClass} data-testid="operator-app" data-surface="operator" aria-busy={busy}>
      <header className="operator-header">
        <div>
          <h1>実験進行コンソール</h1>
        </div>
        <div className="operator-header-actions">
          {isMock ? <span className="rehearsal-pill">実機なし・模擬リハーサル</span> : null}
          <span className={`connection-pill status-${realtime.status}`}>同期 {connectionLabel(realtime.status)}</span>
          <button type="button" className="secondary-button" onClick={() => { void exportCsv(); }} disabled={busy}>
            CSVを出力
          </button>
        </div>
      </header>

      {failure === null ? null : <div className="operator-banner is-failure" role="alert">{failure}</div>}
      {isMock ? (
        <div className="operator-banner is-rehearsal" role="status">
          実機は動作しません。固定模擬データによる開発・リハーサル専用です。本番参加者には使用しないでください。
        </div>
      ) : null}
      {notice === null ? null : <div className="operator-banner" role="status">{notice}</div>}

      <main className="operator-layout">
        <div className="operator-main-column">
          {session === null ? (
            <SetupForm
              researchId={researchId}
              consentConfirmed={consentConfirmed}
              automaticOrder={automaticOrder}
              manualOrder={manualOrder}
              researchIdPattern={researchIdPattern}
              isMock={isMock}
              busy={busy}
              onResearchId={setResearchId}
              onConsent={setConsentConfirmed}
              onAutomaticOrder={setAutomaticOrder}
              onManualOrder={setManualOrder}
              onSubmit={(event) => { void createSession(event); }}
            />
          ) : (
            <>
              <SessionOverview session={session} remainingSeconds={remainingSeconds} realtimeStatus={realtime.status} />
              <ActionPanel
                session={session}
                busy={busy}
                emergencyPending={emergencyPending}
                formComplete={formComplete}
                fullscreenConfirmed={fullscreenConfirmed}
                isMock={isMock}
                onFormComplete={setFormComplete}
                onFullscreenConfirmed={setFullscreenConfirmed}
                onAction={(action) => { void sessionAction(action); }}
                onEmergency={() => { void emergencyStop(); }}
                onReset={() => { void resetForNext(); }}
              />
            </>
          )}
        </div>
        <DeviceAndEvents device={displayedDevice} events={events} busy={busy} onConnect={() => { void connectDevice(); }} />
      </main>
    </div>
  );
}
