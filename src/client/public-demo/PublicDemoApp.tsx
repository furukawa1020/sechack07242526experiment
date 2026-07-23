import { useEffect, useLayoutEffect, useState } from "react";

import {
  PUBLIC_DEMO_CONDITIONS,
  PUBLIC_DEMO_COPY,
  PUBLIC_DEMO_FIRST_PRESENTATION_STEP,
  PUBLIC_DEMO_FIXED_STATE,
  PUBLIC_DEMO_INTRO_STEP,
  PUBLIC_DEMO_REHEARSAL_TIMING_MS,
  PUBLIC_DEMO_SUMMARY_STEP,
  PUBLIC_DEMO_TOTAL_STEPS,
  publicDemoStepLabel,
  type DemoProcessingLocation,
  type PublicDemoCondition,
  type PublicDemoRehearsalTimingMs,
} from "./content.js";

type PublicDemoRehearsalPhase = "handling" | "processing" | "result" | "reset";
type PublicDemoConditionIndex = 0 | 1 | 2 | 3;
type PublicDemoPufferMotion = "resting" | "inflating" | "holding" | "deflating";

interface PublicDemoRehearsalFrame {
  readonly conditionIndex: PublicDemoConditionIndex;
  readonly phase: PublicDemoRehearsalPhase;
}

const FIRST_REHEARSAL_FRAME: PublicDemoRehearsalFrame = Object.freeze({
  conditionIndex: 0,
  phase: "handling",
});

function scrollPublicDemoToTop(): void {
  const isScrolled =
    window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  if (!isScrolled) return;

  try {
    window.scrollTo({ left: 0, top: 0 });
  } catch {
    try {
      window.scrollTo(0, 0);
    } catch {
      // The document scrollTop assignments above remain the compatibility fallback.
    }
  }
}

function nextRehearsalFrame(frame: PublicDemoRehearsalFrame): PublicDemoRehearsalFrame | null {
  switch (frame.phase) {
    case "handling":
      return { ...frame, phase: "processing" };
    case "processing":
      return { ...frame, phase: "result" };
    case "result":
      return { ...frame, phase: "reset" };
    case "reset":
      return frame.conditionIndex === PUBLIC_DEMO_CONDITIONS.length - 1
        ? null
        : {
            conditionIndex: (frame.conditionIndex + 1) as PublicDemoConditionIndex,
            phase: "handling",
          };
  }
}

type HandlingIconKind = DemoProcessingLocation | "storage" | "audience";

const HANDLING_ICON_PATHS: Readonly<Record<HandlingIconKind, string>> = Object.freeze({
  cloud: "M16 47h31a11 11 0 0 0 .8-21.97A16 16 0 0 0 17.2 22.5 12.5 12.5 0 0 0 16 47Z",
  local: "M15 11h34a2 2 0 0 1 2 2v30H13V13a2 2 0 0 1 2-2ZM8 51h48l-4 4H12l-4-4ZM27 51h10",
  storage:
    "M15 15a17 7 0 1 0 34 0 17 7 0 1 0-34 0ZM15 15v17c0 3.87 7.61 7 17 7s17-3.13 17-7V15M15 32v17c0 3.87 7.61 7 17 7s17-3.13 17-7V32",
  audience:
    "M5 32s10-14 27-14 27 14 27 14-10 14-27 14S5 32 5 32ZM39 32a7 7 0 1 1-14 0 7 7 0 1 1 14 0Z",
});

function HandlingIcon({ kind }: { readonly kind: HandlingIconKind }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="public-demo-handling-icon"
      data-icon-kind={kind}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.4"
      viewBox="0 0 64 64"
    >
      <path d={HANDLING_ICON_PATHS[kind]} />
    </svg>
  );
}

export function DemoNotice(): React.JSX.Element {
  return (
    <header className="public-demo-notice" aria-label="公開デモについて">
      <strong>{PUBLIC_DEMO_COPY.notice.title}</strong>
      <span>{PUBLIC_DEMO_COPY.notice.research}</span>
      <span>{PUBLIC_DEMO_COPY.notice.data}</span>
      <span>{PUBLIC_DEMO_COPY.notice.device}</span>
    </header>
  );
}

function DemoFooter(): React.JSX.Element {
  return (
    <footer className="public-demo-participant-footer">
      <strong>{PUBLIC_DEMO_COPY.footer.scenario}</strong>
      <span>{PUBLIC_DEMO_COPY.footer.remember}</span>
      <span>{PUBLIC_DEMO_COPY.footer.medical}</span>
    </footer>
  );
}

function IntroScene(): React.JSX.Element {
  return (
    <section
      aria-labelledby="public-demo-intro-title"
      className="public-demo-intro"
      data-scene="intro"
    >
      <div className="public-demo-intro-content">
        <h1 id="public-demo-intro-title">{PUBLIC_DEMO_COPY.intro.title}</h1>
        <p>{PUBLIC_DEMO_COPY.intro.body}</p>
        <aside>{PUBLIC_DEMO_COPY.intro.scenario}</aside>
      </div>
    </section>
  );
}

function HandlingPanel({
  processing,
}: {
  readonly processing: DemoProcessingLocation;
}): React.JSX.Element {
  const values = PUBLIC_DEMO_COPY.handling[processing];
  const rows = [
    {
      icon: processing,
      label: PUBLIC_DEMO_COPY.handling.fields.processing,
      value: values.processing,
    },
    {
      icon: "storage",
      label: PUBLIC_DEMO_COPY.handling.fields.storage,
      value: values.storage,
    },
    {
      icon: "audience",
      label: PUBLIC_DEMO_COPY.handling.fields.audience,
      value: values.audience,
    },
  ] as const;

  return (
    <section className="public-demo-panel public-demo-handling" data-testid="handling-panel">
      <h2>{PUBLIC_DEMO_COPY.handling.title}</h2>
      <dl>
        {rows.map((row) => (
          <div
            className={row.icon === processing ? "public-demo-processing-location" : undefined}
            key={row.label}
          >
            <dt>{row.label}</dt>
            <dd>
              <HandlingIcon kind={row.icon} />
              <span>{row.value}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PufferFigure({
  motion = "holding",
  motionDurationMs = PUBLIC_DEMO_REHEARSAL_TIMING_MS.pufferInflate,
}: {
  readonly motion?: PublicDemoPufferMotion;
  readonly motionDurationMs?: number;
}): React.JSX.Element {
  const motionStyle = {
    "--public-demo-puffer-motion-duration": `${motionDurationMs}ms`,
  } as React.CSSProperties;

  return (
    <div
      aria-hidden="true"
      className="public-demo-puffer"
      data-motion-duration-ms={motionDurationMs}
      data-puffer-motion={motion}
      data-testid="public-demo-puffer"
      style={motionStyle}
    >
      <span className="public-demo-puffer-tail" />
      <span className="public-demo-puffer-body">
        <span className="public-demo-puffer-eye" />
        <span className="public-demo-puffer-mouth" />
      </span>
    </div>
  );
}

function TimedPufferFigure({
  phase,
  timingMs,
}: {
  readonly phase: "result" | "reset";
  readonly timingMs: PublicDemoRehearsalTimingMs;
}): React.JSX.Element {
  const inflating = phase === "result";
  const [motion, setMotion] = useState<PublicDemoPufferMotion>(
    inflating ? "inflating" : "deflating",
  );
  const durationMs = inflating ? timingMs.pufferInflate : timingMs.pufferDeflate;

  useEffect(() => {
    const timer = window.setTimeout(() => setMotion(inflating ? "holding" : "resting"), durationMs);
    return (): void => window.clearTimeout(timer);
  }, [durationMs, inflating]);

  return <PufferFigure motion={motion} motionDurationMs={durationMs} />;
}

function ResultPanel({
  condition,
  pufferFigure,
}: {
  readonly condition: PublicDemoCondition;
  readonly pufferFigure?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="public-demo-panel public-demo-result" data-testid="result-panel">
      <h2>{PUBLIC_DEMO_COPY.result.title}</h2>
      {condition.presentation === "label" ? (
        <div className="public-demo-label-result">
          <p>{PUBLIC_DEMO_COPY.result.metric}</p>
          <strong
            aria-label={`${PUBLIC_DEMO_COPY.result.metric} ${PUBLIC_DEMO_FIXED_STATE.score} / 100`}
          >
            {PUBLIC_DEMO_FIXED_STATE.score} <span>/ 100</span>
          </strong>
          <b>{PUBLIC_DEMO_FIXED_STATE.label}</b>
        </div>
      ) : (
        <div className="public-demo-puffer-result">
          {pufferFigure ?? <PufferFigure />}
          <div>
            <p>{PUBLIC_DEMO_COPY.result.puffer}</p>
            <small>{PUBLIC_DEMO_COPY.result.deviceNote}</small>
          </div>
        </div>
      )}
    </section>
  );
}

function RehearsalStatusPanel({
  phase,
}: {
  readonly phase: "handling" | "processing";
}): React.JSX.Element {
  const processing = phase === "processing";
  return (
    <section className="public-demo-panel public-demo-rehearsal-status" data-testid="rehearsal-status-panel">
      <h2>{PUBLIC_DEMO_COPY.result.title}</h2>
      <div>
        <p>
          {processing ? PUBLIC_DEMO_COPY.rehearsal.processing : PUBLIC_DEMO_COPY.rehearsal.handling}
        </p>
      </div>
    </section>
  );
}

function PresentationLayout({
  condition,
  position,
  scene,
  rightPanel,
}: {
  readonly condition: PublicDemoCondition;
  readonly position: number;
  readonly scene: Exclude<PublicDemoRehearsalPhase, "reset">;
  readonly rightPanel: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={`public-demo-presentation-title-${position}`}
      className="public-demo-presentation"
      data-scene={scene}
    >
      <header className="public-demo-presentation-header">
        <h1 id={`public-demo-presentation-title-${position}`}>
          {PUBLIC_DEMO_COPY.presentation.position(position)}
        </h1>
        <span>{PUBLIC_DEMO_COPY.presentation.sameData}</span>
      </header>
      <div className="public-demo-comparison">
        <HandlingPanel processing={condition.processing} />
        {rightPanel}
      </div>
      <DemoFooter />
    </section>
  );
}

function PresentationScene({
  condition,
  position,
}: {
  readonly condition: PublicDemoCondition;
  readonly position: number;
}): React.JSX.Element {
  return (
    <PresentationLayout
      condition={condition}
      position={position}
      rightPanel={<ResultPanel condition={condition} />}
      scene="result"
    />
  );
}

function RehearsalResetScene({
  condition,
  position,
  timingMs,
}: {
  readonly condition: PublicDemoCondition;
  readonly position: number;
  readonly timingMs: PublicDemoRehearsalTimingMs;
}): React.JSX.Element {
  const showsPuffer = condition.presentation === "puffer";
  return (
    <section
      aria-labelledby={`public-demo-reset-title-${position}`}
      className="public-demo-presentation"
      data-scene="reset"
    >
      <header className="public-demo-presentation-header">
        <h1>{PUBLIC_DEMO_COPY.presentation.position(position)}</h1>
        <span>{PUBLIC_DEMO_COPY.presentation.sameData}</span>
      </header>
      <div className="public-demo-rehearsal-reset" data-testid="rehearsal-reset-panel">
        <section>
          {showsPuffer ? <TimedPufferFigure phase="reset" timingMs={timingMs} /> : null}
          <div>
            <h2 id={`public-demo-reset-title-${position}`}>
              {PUBLIC_DEMO_COPY.rehearsal.reset.title}
            </h2>
            <p>
              {showsPuffer
                ? PUBLIC_DEMO_COPY.rehearsal.reset.puffer
                : PUBLIC_DEMO_COPY.rehearsal.reset.body}
            </p>
          </div>
        </section>
      </div>
      <DemoFooter />
    </section>
  );
}

function RehearsalScene({
  frame,
  timingMs,
}: {
  readonly frame: PublicDemoRehearsalFrame;
  readonly timingMs: PublicDemoRehearsalTimingMs;
}): React.JSX.Element {
  const condition = PUBLIC_DEMO_CONDITIONS[frame.conditionIndex];
  const position = frame.conditionIndex + 1;

  if (frame.phase === "reset") {
    return <RehearsalResetScene condition={condition} position={position} timingMs={timingMs} />;
  }

  const rightPanel =
    frame.phase === "result" ? (
      <ResultPanel
        condition={condition}
        pufferFigure={<TimedPufferFigure phase="result" timingMs={timingMs} />}
      />
    ) : (
      <RehearsalStatusPanel phase={frame.phase} />
    );

  return (
    <PresentationLayout
      condition={condition}
      position={position}
      rightPanel={rightPanel}
      scene={frame.phase}
    />
  );
}

function conditionLabel(condition: PublicDemoCondition): string {
  if (condition.processing === "cloud") return PUBLIC_DEMO_COPY.summary.conditionLabels.cloudLabel;
  return condition.presentation === "label"
    ? PUBLIC_DEMO_COPY.summary.conditionLabels.localLabel
    : PUBLIC_DEMO_COPY.summary.conditionLabels.localPuffer;
}

function SummaryScene(): React.JSX.Element {
  return (
    <section
      aria-labelledby="public-demo-summary-title"
      className="public-demo-summary"
      data-scene="summary"
      data-testid="public-demo-summary"
    >
      <div className="public-demo-summary-heading">
        <h1 id="public-demo-summary-title">{PUBLIC_DEMO_COPY.summary.title}</h1>
        <p>{PUBLIC_DEMO_COPY.summary.body}</p>
      </div>
      <ol>
        {PUBLIC_DEMO_CONDITIONS.map((condition, index) => (
          <li key={`${condition.processing}-${condition.presentation}-${index}`}>
            <span>{PUBLIC_DEMO_COPY.summary.cards[index]}</span>
            <strong>{conditionLabel(condition)}</strong>
          </li>
        ))}
      </ol>
      <p className="public-demo-summary-note">{PUBLIC_DEMO_COPY.summary.note}</p>
      <DemoFooter />
    </section>
  );
}

export function Scene({ step }: { readonly step: number }): React.JSX.Element {
  useLayoutEffect(() => {
    scrollPublicDemoToTop();
  }, [step]);

  if (step === PUBLIC_DEMO_INTRO_STEP) return <IntroScene />;
  if (step === PUBLIC_DEMO_SUMMARY_STEP) return <SummaryScene />;

  const condition = PUBLIC_DEMO_CONDITIONS[step - PUBLIC_DEMO_FIRST_PRESENTATION_STEP];
  if (condition === undefined) throw new RangeError(`Public demo step is out of range: ${step}`);
  return <PresentationScene condition={condition} position={step} />;
}

export function PublicDemoApp({
  rehearsalTimingMs = PUBLIC_DEMO_REHEARSAL_TIMING_MS,
}: {
  readonly rehearsalTimingMs?: PublicDemoRehearsalTimingMs;
}): React.JSX.Element {
  const [step, setStep] = useState(PUBLIC_DEMO_INTRO_STEP);
  const [rehearsalFrame, setRehearsalFrame] = useState<PublicDemoRehearsalFrame | null>(null);
  const rehearsalRunning = rehearsalFrame !== null;

  useLayoutEffect(() => {
    scrollPublicDemoToTop();
  }, [rehearsalFrame]);

  useEffect(() => {
    if (rehearsalFrame === null) return undefined;
    const phaseDurationMs = rehearsalTimingMs[rehearsalFrame.phase];
    const timer = window.setTimeout(() => {
      const nextFrame = nextRehearsalFrame(rehearsalFrame);
      if (nextFrame === null) {
        setStep(PUBLIC_DEMO_SUMMARY_STEP);
        setRehearsalFrame(null);
      } else {
        setRehearsalFrame(nextFrame);
      }
    }, phaseDurationMs);
    return (): void => window.clearTimeout(timer);
  }, [rehearsalFrame, rehearsalTimingMs]);

  const startRehearsal = (): void => {
    setStep(PUBLIC_DEMO_INTRO_STEP);
    setRehearsalFrame(FIRST_REHEARSAL_FRAME);
  };

  const stopRehearsal = (): void => {
    if (rehearsalFrame !== null) {
      setStep(rehearsalFrame.conditionIndex + PUBLIC_DEMO_FIRST_PRESENTATION_STEP);
    }
    setRehearsalFrame(null);
  };

  const rehearsalPhaseLabel =
    rehearsalFrame === null ? null : PUBLIC_DEMO_COPY.rehearsal.phases[rehearsalFrame.phase];

  return (
    <div
      className="public-demo-app"
      data-rehearsal-mode={rehearsalRunning ? "automatic" : "manual"}
      data-testid="public-demo-app"
    >
      <DemoNotice />
      <main
        className="public-demo-stage"
        data-rehearsal-phase={rehearsalFrame?.phase}
        data-rehearsal-position={
          rehearsalFrame === null ? undefined : rehearsalFrame.conditionIndex + 1
        }
        aria-label="固定模擬データの表示確認"
      >
        {rehearsalFrame === null ? (
          <Scene step={step} />
        ) : (
          <RehearsalScene frame={rehearsalFrame} timingMs={rehearsalTimingMs} />
        )}
      </main>
      <nav className="public-demo-controls" aria-label="公開デモの画面操作">
        <button
          className="public-demo-previous"
          type="button"
          disabled={rehearsalRunning || step === PUBLIC_DEMO_INTRO_STEP}
          onClick={() => setStep((current) => Math.max(PUBLIC_DEMO_INTRO_STEP, current - 1))}
        >
          {PUBLIC_DEMO_COPY.navigation.previous}
        </button>
        <output aria-live="polite">
          {rehearsalFrame === null || rehearsalPhaseLabel === null
            ? `${publicDemoStepLabel(step)}（${step + 1} / ${PUBLIC_DEMO_TOTAL_STEPS}画面）`
            : `${PUBLIC_DEMO_COPY.rehearsal.running}・${PUBLIC_DEMO_COPY.rehearsal.progress(
                rehearsalFrame.conditionIndex + 1,
                rehearsalPhaseLabel,
              )}`}
        </output>
        <button
          className="public-demo-next"
          type="button"
          disabled={rehearsalRunning || step === PUBLIC_DEMO_SUMMARY_STEP}
          onClick={() => setStep((current) => Math.min(PUBLIC_DEMO_SUMMARY_STEP, current + 1))}
        >
          {PUBLIC_DEMO_COPY.navigation.next}
        </button>
        <button
          aria-pressed={rehearsalRunning}
          className="public-demo-rehearsal-control"
          onClick={rehearsalRunning ? stopRehearsal : startRehearsal}
          type="button"
        >
          {rehearsalRunning ? PUBLIC_DEMO_COPY.rehearsal.stop : PUBLIC_DEMO_COPY.rehearsal.start}
        </button>
      </nav>
    </div>
  );
}
