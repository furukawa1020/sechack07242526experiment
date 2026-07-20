import { useState } from "react";

import {
  PUBLIC_DEMO_CONDITIONS,
  PUBLIC_DEMO_COPY,
  PUBLIC_DEMO_FIXED_STATE,
  type DemoProcessingLocation,
  type PublicDemoCondition,
} from "./content.js";

const INTRO_STEP = 0;
const FIRST_PRESENTATION_STEP = 1;
const LAST_PRESENTATION_STEP = PUBLIC_DEMO_CONDITIONS.length;
const SUMMARY_STEP = LAST_PRESENTATION_STEP + 1;
const TOTAL_STEPS = SUMMARY_STEP + 1;

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

function DemoNotice(): React.JSX.Element {
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
    <main className="public-demo-intro" data-scene="intro">
      <section className="public-demo-intro-content">
        <h1>{PUBLIC_DEMO_COPY.intro.title}</h1>
        <p>{PUBLIC_DEMO_COPY.intro.body}</p>
        <aside>{PUBLIC_DEMO_COPY.intro.scenario}</aside>
      </section>
    </main>
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

function PufferFigure(): React.JSX.Element {
  return (
    <div className="public-demo-puffer" data-testid="public-demo-puffer" aria-hidden="true">
      <span className="public-demo-puffer-tail" />
      <span className="public-demo-puffer-body">
        <span className="public-demo-puffer-eye" />
        <span className="public-demo-puffer-mouth" />
      </span>
    </div>
  );
}

function ResultPanel({
  condition,
}: {
  readonly condition: PublicDemoCondition;
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
          <PufferFigure />
          <div>
            <p>{PUBLIC_DEMO_COPY.result.puffer}</p>
            <small>{PUBLIC_DEMO_COPY.result.deviceNote}</small>
          </div>
        </div>
      )}
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
    <article className="public-demo-presentation" data-scene="result">
      <header className="public-demo-presentation-header">
        <strong>{PUBLIC_DEMO_COPY.presentation.position(position)}</strong>
        <span>{PUBLIC_DEMO_COPY.presentation.sameData}</span>
      </header>
      <main className="public-demo-comparison">
        <HandlingPanel processing={condition.processing} />
        <ResultPanel condition={condition} />
      </main>
      <DemoFooter />
    </article>
  );
}

function conditionLabel(condition: PublicDemoCondition): string {
  return PUBLIC_DEMO_COPY.summary.conditionLabels[condition.processing][condition.presentation];
}

function SummaryScene(): React.JSX.Element {
  return (
    <main className="public-demo-summary" data-scene="summary" data-testid="public-demo-summary">
      <section className="public-demo-summary-heading">
        <h1>{PUBLIC_DEMO_COPY.summary.title}</h1>
        <p>{PUBLIC_DEMO_COPY.summary.body}</p>
      </section>
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
    </main>
  );
}

function Scene({ step }: { readonly step: number }): React.JSX.Element {
  if (step === INTRO_STEP) return <IntroScene />;
  if (step === SUMMARY_STEP) return <SummaryScene />;

  const condition = PUBLIC_DEMO_CONDITIONS[step - FIRST_PRESENTATION_STEP];
  if (condition === undefined) throw new RangeError(`Public demo step is out of range: ${step}`);
  return <PresentationScene condition={condition} position={step} />;
}

function stepLabel(step: number): string {
  if (step === INTRO_STEP) return PUBLIC_DEMO_COPY.navigation.intro;
  if (step === SUMMARY_STEP) return PUBLIC_DEMO_COPY.navigation.summary;
  return PUBLIC_DEMO_COPY.presentation.position(step);
}

export function PublicDemoApp(): React.JSX.Element {
  const [step, setStep] = useState(INTRO_STEP);

  return (
    <div className="public-demo-app" data-testid="public-demo-app">
      <DemoNotice />
      <section
        className="public-demo-stage"
        aria-label="固定模擬データの表示確認"
        aria-live="polite"
      >
        <Scene step={step} />
      </section>
      <nav className="public-demo-controls" aria-label="公開デモの画面操作">
        <button
          type="button"
          disabled={step === INTRO_STEP}
          onClick={() => setStep((current) => Math.max(INTRO_STEP, current - 1))}
        >
          {PUBLIC_DEMO_COPY.navigation.previous}
        </button>
        <output>
          {stepLabel(step)}（{step + 1} / {TOTAL_STEPS}画面）
        </output>
        <button
          type="button"
          disabled={step === SUMMARY_STEP}
          onClick={() => setStep((current) => Math.min(SUMMARY_STEP, current + 1))}
        >
          {PUBLIC_DEMO_COPY.navigation.next}
        </button>
      </nav>
    </div>
  );
}
