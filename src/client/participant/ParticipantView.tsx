import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { UI_COPY, formatPresentationPosition } from "../../shared/copy.js";
import type {
  ParticipantFixedState,
  ParticipantSnapshot,
  PresentationMode,
  ProcessingLocation,
  PublicCondition,
} from "../shared/model.js";

interface ParticipantViewProps {
  readonly snapshot: ParticipantSnapshot;
}

function Footer(): React.JSX.Element {
  return (
    <footer className="participant-footer">
      <strong>{UI_COPY.footer.scenario}</strong>
      <span>{UI_COPY.footer.remember}</span>
      <span>{UI_COPY.footer.medical}</span>
    </footer>
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

function Intro(): React.JSX.Element {
  return (
    <main className="participant-intro">
      <section className="intro-card">
        <h1>{UI_COPY.intro.title}</h1>
        <p className="intro-body multiline-copy">{UI_COPY.intro.body}</p>
        <aside className="scenario-note">
          <p className="multiline-copy">{UI_COPY.intro.scenario}</p>
        </aside>
        <p className="waiting-copy">{UI_COPY.intro.waiting}</p>
      </section>
    </main>
  );
}

function ConditionHeader({ sequenceIndex }: { readonly sequenceIndex: 0 | 1 | 2 | 3 | null }): React.JSX.Element {
  const position = sequenceIndex === null ? 1 : sequenceIndex + 1;
  return (
    <header className="condition-header">
      <strong>{formatPresentationPosition(position as 1 | 2 | 3 | 4)}</strong>
      <span>{UI_COPY.header.sameData}</span>
    </header>
  );
}

function FieldIcon({ kind }: { readonly kind: "processing" | "storage" | "audience" }): React.JSX.Element {
  if (kind === "processing") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="12" rx="2" />
        <path d="M9 21h6M12 17v4" />
      </svg>
    );
  }
  if (kind === "storage") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

export function HandlingPanel({ processing }: { readonly processing: ProcessingLocation }): React.JSX.Element {
  const values = UI_COPY.handling[processing];
  const rows = [
    { key: "processing" as const, label: UI_COPY.handling.fields.processing, value: values.processing },
    { key: "storage" as const, label: UI_COPY.handling.fields.storage, value: values.storage },
    { key: "audience" as const, label: UI_COPY.handling.fields.audience, value: values.audience },
  ];
  return (
    <section className="condition-panel handling-panel" data-testid="handling-panel" aria-labelledby="handling-title">
      <h1 id="handling-title">{UI_COPY.handling.title}</h1>
      <dl className="handling-fields">
        {rows.map((row) => (
          <div className="handling-row" key={row.key}>
            <span className="field-icon"><FieldIcon kind={row.key} /></span>
            <div>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ResultPanel({
  presentation,
  fixedState,
}: {
  readonly presentation: PresentationMode;
  readonly fixedState: ParticipantFixedState | null;
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
      ) : presentation === "puffer" ? (
        <div className="puffer-result">
          <div className="puffer-symbol" aria-hidden="true">
            <span className="puffer-body" />
            <span className="puffer-arrow">→</span>
          </div>
          <p className="multiline-copy">{UI_COPY.result.puffer}</p>
        </div>
      ) : <p className="multiline-copy">{UI_COPY.intro.waiting}</p>}
    </section>
  );
}

function AwaitingPanel(): React.JSX.Element {
  return (
    <section className="condition-panel neutral-panel" aria-hidden="true">
      <div className="neutral-orbit"><span /><span /><span /></div>
    </section>
  );
}

function ProcessingPanel(): React.JSX.Element {
  return (
    <section className="condition-panel processing-panel" aria-live="polite">
      <div className="processing-spinner" aria-hidden="true" />
      <p>{UI_COPY.processing}</p>
    </section>
  );
}

function ConditionStage({ snapshot }: { readonly snapshot: ParticipantSnapshot }): React.JSX.Element {
  const processing = snapshot.condition?.processing ?? "local";
  return (
    <div className="participant-condition-stage">
      <ConditionHeader sequenceIndex={snapshot.sequenceIndex} />
      <main className="condition-grid">
        <HandlingPanel processing={processing} />
        {snapshot.phase === "handling" ? <AwaitingPanel /> : null}
        {snapshot.phase === "processing" ? <ProcessingPanel /> : null}
        {snapshot.phase === "result" && snapshot.condition !== null ? (
          <ResultPanel presentation={snapshot.condition.presentation} fixedState={snapshot.fixedState} />
        ) : null}
      </main>
    </div>
  );
}

function conditionLabel(condition: PublicCondition): string {
  return UI_COPY.summary.conditionLabels[condition.processing][condition.presentation];
}

function FormQr({ url }: { readonly url: string }): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 128,
      color: { dark: "#172033", light: "#FFFFFF" },
    }).then((generated) => {
      if (current) setDataUrl(generated);
    }).catch(() => {
      if (current) setDataUrl(null);
    });
    return () => { current = false; };
  }, [url]);

  return (
    <div className="form-actions">
      <a className="form-link" href={url} target="_blank" rel="noreferrer">
        {UI_COPY.summary.formCta}
      </a>
      <div className="form-qr">
        {dataUrl === null ? <span className="qr-placeholder" aria-hidden="true" /> : (
          <img src={dataUrl} width="104" height="104" alt="Googleフォームを開くQRコード" />
        )}
        <p>{UI_COPY.summary.qrHelp}</p>
      </div>
    </div>
  );
}

function Summary({ snapshot }: { readonly snapshot: ParticipantSnapshot }): React.JSX.Element {
  return (
    <main className="participant-summary">
      <section className="summary-heading">
        <h1>{UI_COPY.summary.title}</h1>
        <p className="multiline-copy">{UI_COPY.summary.body}</p>
      </section>
      <ol className="summary-grid" aria-label="提示の一覧">
        {snapshot.summary.slice(0, 4).map((condition, index) => (
          <li key={`${condition.processing}-${condition.presentation}-${index}`}>
            <span>{UI_COPY.summary.cards[index]}</span>
            <strong>{conditionLabel(condition)}</strong>
          </li>
        ))}
      </ol>
      <p className="summary-note">{UI_COPY.summary.note}</p>
      {snapshot.formUrl === null ? null : <FormQr url={snapshot.formUrl} />}
    </main>
  );
}

function phaseContent(snapshot: ParticipantSnapshot): React.JSX.Element {
  switch (snapshot.phase) {
    case "idle":
    case "setup":
    case "intro":
      return <Intro />;
    case "handling":
    case "processing":
    case "result":
      return <ConditionStage snapshot={snapshot} />;
    case "reset":
      return <CenteredMessage title={UI_COPY.reset.title} body={UI_COPY.reset.waiting} />;
    case "summary":
      return <Summary snapshot={snapshot} />;
    case "completed":
      return <CenteredMessage title={UI_COPY.completed.title} body={UI_COPY.completed.waiting} />;
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
      data-surface="participant"
    >
      {phaseContent(snapshot)}
      <Footer />
    </div>
  );
}
