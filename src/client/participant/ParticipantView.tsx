import type { CSSProperties } from "react";
import {
  UI_COPY,
  formatPresentationPosition,
  formatResponseCheckpointTitle,
} from "../../shared/copy.js";
import type {
  ParticipantFixedState,
  ParticipantSnapshot,
  PufferSurface,
  PresentationMode,
  ProcessingLocation,
  PublicCondition,
} from "../shared/model.js";

const SCREEN_PUFFER_CONTRACTED_SCALE = 0.52;
const SCREEN_PUFFER_EXPANDED_SCALE = 1;

type ScreenPufferPhase = "result" | "reset";

interface ScreenPufferMotion {
  readonly rampMs: number;
  readonly elapsedMs: number;
}

type PufferAnimationStyle = CSSProperties & Readonly<{
  "--screen-puffer-contracted-scale": string;
  "--screen-puffer-expanded-scale": string;
}>;

interface ParticipantViewProps {
  readonly snapshot: ParticipantSnapshot;
}

function Footer(): React.JSX.Element {
  return (
    <footer className="participant-footer">
      <strong>{UI_COPY.footer.scenario}</strong>
      <span>{UI_COPY.footer.remember}</span>
      <span>{UI_COPY.footer.medical}</span>
      <span>{UI_COPY.footer.withdrawal}</span>
    </footer>
  );
}

function RehearsalNotice(): React.JSX.Element {
  return (
    <aside className="participant-rehearsal-notice" role="note">
      <strong>{UI_COPY.rehearsal.title}</strong>
      <span>{UI_COPY.rehearsal.body}</span>
    </aside>
  );
}

function CenteredMessage({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <main className="participant-centered" aria-live="polite">
      <section className="participant-message-card">
        <h1>{title}</h1>
        <p className="multiline-copy">{body}</p>
      </section>
    </main>
  );
}

function Intro({ pufferSurface }: { readonly pufferSurface: PufferSurface }): React.JSX.Element {
  return (
    <main className="participant-intro">
      <section className="intro-card">
        <h1>{UI_COPY.intro.title}</h1>
        <p className="intro-body multiline-copy">{UI_COPY.intro.body}</p>
        <aside className="scenario-note">
          <p className="multiline-copy">
            {pufferSurface === "screen" ? UI_COPY.intro.scenario : UI_COPY.intro.physicalScenario}
          </p>
        </aside>
        <p className="waiting-copy">{UI_COPY.intro.waiting}</p>
      </section>
    </main>
  );
}

function ConditionHeader({ sequenceIndex }: { readonly sequenceIndex: 0 | 1 | 2 | 3 }): React.JSX.Element {
  const position = sequenceIndex + 1;
  return (
    <header className="condition-header">
      <strong>{formatPresentationPosition(position as 1 | 2 | 3 | 4)}</strong>
      <span>{UI_COPY.header.sameData}</span>
    </header>
  );
}

type FieldIconKind = "cloud" | "device" | "storage" | "audience";

const FIELD_ICON_PATHS: Readonly<Record<FieldIconKind, string>> = {
  cloud: "M7 18.5h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.45 9.1 4.75 4.75 0 0 0 7 18.5Z",
  device: "M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM8.5 21h7M12 17.5V21",
  storage: "M20 5c0 1.66-3.58 3-8 3S4 6.66 4 5s3.58-3 8-3 8 1.34 8 3ZM4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7",
  audience: "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6ZM14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
};

function FieldIcon({ kind }: { readonly kind: FieldIconKind }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={FIELD_ICON_PATHS[kind]} />
    </svg>
  );
}

export function HandlingPanel({ processing }: { readonly processing: ProcessingLocation }): React.JSX.Element {
  const values = UI_COPY.handling[processing];
  const rows = [
    {
      key: "processing" as const,
      icon: processing === "cloud" ? "cloud" as const : "device" as const,
      label: UI_COPY.handling.fields.processing,
      value: values.processing,
    },
    {
      key: "storage" as const,
      icon: "storage" as const,
      label: UI_COPY.handling.fields.storage,
      value: values.storage,
    },
    {
      key: "audience" as const,
      icon: "audience" as const,
      label: UI_COPY.handling.fields.audience,
      value: values.audience,
    },
  ];
  return (
    <section className="condition-panel handling-panel" data-testid="handling-panel" aria-labelledby="handling-title">
      <h1 id="handling-title">{UI_COPY.handling.title}</h1>
      <dl className="handling-fields">
        {rows.map((row) => (
          <div
            className={`handling-row${row.key === "processing" ? " handling-row-location" : ""}`}
            key={row.key}
          >
            <dt>
              <span className="field-icon"><FieldIcon kind={row.icon} /></span>
              {row.label}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ResultPanel({
  presentation,
  fixedState,
  pufferSurface,
  screenPufferMotion,
}: {
  readonly presentation: PresentationMode;
  readonly fixedState: ParticipantFixedState | null;
  readonly pufferSurface: PufferSurface;
  readonly screenPufferMotion: ScreenPufferMotion | null;
}): React.JSX.Element {
  return (
    <section className="condition-panel result-panel" data-testid="result-panel" aria-labelledby="result-title">
      <h2 id="result-title">{UI_COPY.result.title}</h2>
      {presentation === "label" && fixedState !== null ? (
        <div className="label-result">
          <p className="metric-label">{UI_COPY.result.metric}</p>
          <p className="metric-value" aria-label={`${UI_COPY.result.metric} ${fixedState.score} / 100`}>
            {fixedState.score} <span>/ 100</span>
          </p>
          <p className="state-label">{fixedState.label}</p>
        </div>
      ) : presentation === "puffer" && pufferSurface === "screen" && screenPufferMotion !== null ? (
        <div className="puffer-result screen-puffer-result">
          <ScreenPufferVisual phase="result" motion={screenPufferMotion} />
          <p className="multiline-copy">{UI_COPY.result.pufferScreen}</p>
        </div>
      ) : presentation === "puffer" ? (
        <div className="puffer-result">
          <div className="puffer-symbol" aria-hidden="true">
            <span className="puffer-body" />
            <span className="puffer-arrow">→</span>
          </div>
          <p className="multiline-copy">{UI_COPY.result.pufferPhysical}</p>
        </div>
      ) : <p className="multiline-copy">{UI_COPY.intro.waiting}</p>}
    </section>
  );
}

function screenPufferMotion(snapshot: ParticipantSnapshot): ScreenPufferMotion | null {
  if (
    snapshot.pufferRamp === null
    || snapshot.phaseStartedAt === null
    || snapshot.phaseEndsAt === null
    || snapshot.serverNow === null
    || snapshot.remainingMs === null
    || !Number.isFinite(Date.parse(snapshot.phaseStartedAt))
    || !Number.isFinite(Date.parse(snapshot.phaseEndsAt))
    || !Number.isFinite(Date.parse(snapshot.serverNow))
  ) {
    return null;
  }
  const rampMs = snapshot.phase === "reset"
    ? snapshot.pufferRamp.deflateMs
    : snapshot.pufferRamp.inflateMs;
  const phaseDurationMs = Math.max(
    0,
    Date.parse(snapshot.phaseEndsAt) - Date.parse(snapshot.phaseStartedAt),
  );
  return {
    rampMs,
    // remainingMs is derived from the server's monotonic clock. Wall-clock
    // correction may move serverNow, but must never rewind the stimulus.
    elapsedMs: Math.max(0, phaseDurationMs - snapshot.remainingMs),
  };
}

function pufferAnimationStyle(
  phase: ScreenPufferPhase,
  motion: ScreenPufferMotion,
): PufferAnimationStyle {
  const elapsedMs = Math.min(
    motion.rampMs,
    motion.elapsedMs,
  );
  return {
    "--screen-puffer-contracted-scale": String(SCREEN_PUFFER_CONTRACTED_SCALE),
    "--screen-puffer-expanded-scale": String(SCREEN_PUFFER_EXPANDED_SCALE),
    animationName: phase === "result" ? "screen-puffer-inflate" : "screen-puffer-deflate",
    animationDuration: `${motion.rampMs}ms`,
    animationDelay: `-${elapsedMs}ms`,
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationIterationCount: 1,
  };
}

function ScreenPufferVisual({
  phase,
  motion,
}: {
  readonly phase: ScreenPufferPhase;
  readonly motion: ScreenPufferMotion;
}): React.JSX.Element {
  const elapsedMs = Math.min(
    motion.rampMs,
    motion.elapsedMs,
  );
  const motionState = phase === "result"
    ? elapsedMs < motion.rampMs ? "inflating" : "holding"
    : elapsedMs < motion.rampMs ? "deflating" : "resting";
  return (
    <div
      className="screen-puffer-visual"
      aria-hidden="true"
      data-testid="screen-puffer-visual"
      data-puffer-motion={motionState}
      data-motion-duration-ms={motion.rampMs}
    >
      <span className="screen-puffer-body" style={pufferAnimationStyle(phase, motion)}>
        <span className="screen-puffer-eye" />
        <span className="screen-puffer-mouth" />
        <span className="screen-puffer-fin" />
      </span>
    </div>
  );
}

function AwaitingPanel(): React.JSX.Element {
  return (
    <section className="condition-panel handling-message-panel" aria-live="polite">
      <p>{UI_COPY.footer.remember}</p>
    </section>
  );
}

function ProcessingPanel(): React.JSX.Element {
  return (
    <section className="condition-panel processing-panel" aria-live="polite">
      <div className="processing-content">
        <div className="processing-spinner" aria-hidden="true" />
        <p>{UI_COPY.processing}</p>
      </div>
    </section>
  );
}

function ConditionStage({ snapshot }: { readonly snapshot: ParticipantSnapshot }): React.JSX.Element {
  const motion = screenPufferMotion(snapshot);
  if (
    snapshot.condition === null
    || snapshot.sequenceIndex === null
    || (snapshot.phase === "result"
      && snapshot.condition.presentation === "label"
      && snapshot.fixedState === null)
    || (snapshot.phase === "result"
      && snapshot.condition?.presentation === "puffer"
      && snapshot.pufferSurface === "screen"
      && motion === null)
  ) {
    return <CenteredMessage title={UI_COPY.error.title} body={UI_COPY.error.waiting} />;
  }
  const condition = snapshot.condition;
  return (
    <div className="participant-condition-stage">
      <ConditionHeader sequenceIndex={snapshot.sequenceIndex} />
      <main className="condition-grid">
        <HandlingPanel processing={condition.processing} />
        {snapshot.phase === "handling" ? <AwaitingPanel /> : null}
        {snapshot.phase === "processing" ? <ProcessingPanel /> : null}
        {snapshot.phase === "result" ? (
          <ResultPanel
            presentation={condition.presentation}
            fixedState={snapshot.fixedState}
            pufferSurface={snapshot.pufferSurface}
            screenPufferMotion={motion}
          />
        ) : null}
      </main>
    </div>
  );
}

function ScreenPufferReset({ snapshot }: { readonly snapshot: ParticipantSnapshot }): React.JSX.Element {
  const motion = screenPufferMotion(snapshot);
  if (motion === null) {
    return <CenteredMessage title={UI_COPY.error.title} body={UI_COPY.error.waiting} />;
  }
  return (
    <main className="participant-centered screen-puffer-reset" aria-live="polite">
      <section className="participant-message-card screen-puffer-reset-card">
        <h1>{UI_COPY.reset.title}</h1>
        <ScreenPufferVisual phase="reset" motion={motion} />
        <p>{UI_COPY.reset.waiting}</p>
      </section>
    </main>
  );
}

function ResponseCheckpoint({
  sequenceIndex,
}: {
  readonly sequenceIndex: 0 | 1 | 2 | 3 | null;
}): React.JSX.Element {
  if (sequenceIndex === null) {
    return <CenteredMessage title={UI_COPY.error.title} body={UI_COPY.error.waiting} />;
  }
  const position = sequenceIndex + 1;
  return (
    <CenteredMessage
      title={formatResponseCheckpointTitle(position as 1 | 2 | 3 | 4)}
      body={UI_COPY.response.waiting}
    />
  );
}

function conditionLabel(condition: PublicCondition, pufferSurface: PufferSurface): string {
  if (pufferSurface === "screen" && condition.presentation === "puffer") {
    return UI_COPY.summary.screenPufferLabels[condition.processing];
  }
  return UI_COPY.summary.conditionLabels[condition.processing][condition.presentation];
}

function Summary({ snapshot }: { readonly snapshot: ParticipantSnapshot }): React.JSX.Element {
  return (
    <main className="participant-summary">
      <section className="summary-heading">
        <h1>{UI_COPY.summary.title}</h1>
        <p className="multiline-copy">
          {snapshot.rehearsal ? UI_COPY.rehearsal.summary : UI_COPY.summary.body}
        </p>
      </section>
      <ol className="summary-grid" aria-label={UI_COPY.summary.listLabel}>
        {snapshot.summary.slice(0, 4).map((condition, index) => (
          <li key={`${condition.processing}-${condition.presentation}-${index}`}>
            <span>{UI_COPY.summary.cards[index]}</span>
            <strong>{conditionLabel(condition, snapshot.pufferSurface)}</strong>
          </li>
        ))}
      </ol>
    </main>
  );
}

function phaseContent(snapshot: ParticipantSnapshot): React.JSX.Element {
  switch (snapshot.phase) {
    case "idle":
    case "setup":
    case "intro":
      return <Intro pufferSurface={snapshot.pufferSurface} />;
    case "handling":
    case "processing":
    case "result":
      return <ConditionStage snapshot={snapshot} />;
    case "reset":
      if (
        snapshot.pufferSurface === "screen"
        && snapshot.condition?.presentation === "puffer"
      ) {
        return <ScreenPufferReset snapshot={snapshot} />;
      }
      return <CenteredMessage title={UI_COPY.reset.title} body={UI_COPY.reset.waiting} />;
    case "response":
      return <ResponseCheckpoint sequenceIndex={snapshot.sequenceIndex} />;
    case "summary":
      return <Summary snapshot={snapshot} />;
    case "completed":
      return snapshot.rehearsal
        ? <CenteredMessage title={UI_COPY.rehearsal.completedTitle} body={UI_COPY.rehearsal.completedWaiting} />
        : <CenteredMessage title={UI_COPY.completed.title} body={UI_COPY.completed.waiting} />;
    case "aborted":
      return <CenteredMessage title={UI_COPY.aborted.title} body={UI_COPY.aborted.waiting} />;
    case "error":
      return <CenteredMessage title={UI_COPY.error.title} body={UI_COPY.error.waiting} />;
    case "recovery":
      return <CenteredMessage title={UI_COPY.error.title} body={UI_COPY.intro.waiting} />;
  }
}

export function ParticipantView({ snapshot }: ParticipantViewProps): React.JSX.Element {
  return (
    <div
      className="participant-app"
      data-testid="participant-app"
      data-phase={snapshot.phase}
      data-rehearsal={snapshot.rehearsal ? "true" : "false"}
      data-surface="participant"
    >
      {snapshot.rehearsal ? <RehearsalNotice /> : null}
      {phaseContent(snapshot)}
      {snapshot.phase === "response" ? null : <Footer />}
    </div>
  );
}
