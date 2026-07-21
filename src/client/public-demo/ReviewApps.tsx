import { useEffect, useRef, useState } from "react";

import {
  DemoNotice,
  Scene,
} from "./PublicDemoApp.js";
import {
  PUBLIC_DEMO_COPY,
  PUBLIC_DEMO_INTRO_STEP,
  PUBLIC_DEMO_SUMMARY_STEP,
  PUBLIC_DEMO_TOTAL_STEPS,
  publicDemoStepLabel,
} from "./content.js";

const REVIEW_CHANNEL_NAME = "sechack-public-review-display-v1";

interface ReviewReadyMessage {
  readonly type: "review.ready";
}

interface ReviewStepMessage {
  readonly type: "review.step";
  readonly step: number;
}

type ReviewMessage = ReviewReadyMessage | ReviewStepMessage;

function isReviewStep(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= PUBLIC_DEMO_INTRO_STEP &&
    Number(value) <= PUBLIC_DEMO_SUMMARY_STEP
  );
}

function parseReviewMessage(value: unknown): ReviewMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record["type"] === "review.ready") return { type: "review.ready" };
  if (record["type"] === "review.step" && isReviewStep(record["step"])) {
    return { type: "review.step", step: Number(record["step"]) };
  }
  return null;
}

function createReviewChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(REVIEW_CHANNEL_NAME);
}

function ReviewShell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="public-review-shell">
      <DemoNotice />
      {children}
    </div>
  );
}

export function PublicOperatorApp(): React.JSX.Element {
  const [step, setStep] = useState(PUBLIC_DEMO_INTRO_STEP);
  const stepRef = useRef(step);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const channel = createReviewChannel();
    channelRef.current = channel;
    if (channel === null) return undefined;

    channel.onmessage = (event: MessageEvent<unknown>): void => {
      const message = parseReviewMessage(event.data);
      if (message?.type === "review.ready") {
        channel.postMessage({ type: "review.step", step: stepRef.current } satisfies ReviewStepMessage);
      }
    };
    channel.postMessage({ type: "review.step", step: stepRef.current } satisfies ReviewStepMessage);

    return (): void => {
      channelRef.current = null;
      channel.close();
    };
  }, []);

  useEffect(() => {
    stepRef.current = step;
    channelRef.current?.postMessage({ type: "review.step", step } satisfies ReviewStepMessage);
  }, [step]);

  return (
    <ReviewShell>
      <main className="public-review-operator" data-testid="public-review-operator">
        <section className="public-review-heading">
          <h1>{PUBLIC_DEMO_COPY.review.operator.title}</h1>
          <p>{PUBLIC_DEMO_COPY.review.operator.description}</p>
        </section>

        <section className="public-review-operator-grid">
          <div className="public-review-control-panel">
            <h2>表示を選ぶ</h2>
            <div className="public-review-scene-buttons">
              {PUBLIC_DEMO_COPY.review.operator.scenes.map((scene, index) => (
                <button
                  aria-pressed={step === index}
                  key={scene}
                  onClick={() => setStep(index)}
                  type="button"
                >
                  {scene}
                </button>
              ))}
            </div>
          </div>

          <div className="public-review-current-panel" aria-live="polite">
            <span>{PUBLIC_DEMO_COPY.review.operator.current}</span>
            <strong>{publicDemoStepLabel(step)}</strong>
            <p>
              {step + 1} / {PUBLIC_DEMO_TOTAL_STEPS}画面
            </p>
            <small>{PUBLIC_DEMO_COPY.review.operator.connection}</small>
          </div>
        </section>

        <nav className="public-review-links" aria-label="公開レビュー画面">
          <a href="/display-demo.html" rel="noopener" target="_blank">
            {PUBLIC_DEMO_COPY.review.operator.displayLink}
          </a>
          <a href="/device-test.html">{PUBLIC_DEMO_COPY.review.operator.deviceLink}</a>
        </nav>
      </main>
    </ReviewShell>
  );
}

export function PublicDisplayApp(): React.JSX.Element {
  const [step, setStep] = useState(PUBLIC_DEMO_INTRO_STEP);
  const channelAvailable = typeof BroadcastChannel !== "undefined";

  useEffect(() => {
    const channel = createReviewChannel();
    if (channel === null) return undefined;

    channel.onmessage = (event: MessageEvent<unknown>): void => {
      const message = parseReviewMessage(event.data);
      if (message?.type === "review.step") setStep(message.step);
    };
    channel.postMessage({ type: "review.ready" } satisfies ReviewReadyMessage);

    return (): void => channel.close();
  }, []);

  return (
    <ReviewShell>
      <section
        className="public-review-display-stage"
        data-testid="public-review-display"
        aria-label="読み取り専用の参加者表示レビュー"
        aria-live="polite"
      >
        <Scene step={step} />
      </section>
      {channelAvailable ? null : (
        <p className="public-review-display-note">{PUBLIC_DEMO_COPY.review.display.waiting}</p>
      )}
    </ReviewShell>
  );
}

type MockReviewDeviceState = "disconnected" | "idle" | "holding" | "stopped";

export function PublicDeviceTestApp(): React.JSX.Element {
  const [state, setState] = useState<MockReviewDeviceState>("disconnected");
  const copy = PUBLIC_DEMO_COPY.review.device;
  const stateLabels: Readonly<Record<MockReviewDeviceState, string>> = {
    disconnected: copy.disconnected,
    idle: copy.idle,
    holding: copy.holding,
    stopped: copy.stopped,
  };
  const connected = state !== "disconnected";

  return (
    <ReviewShell>
      <main className="public-review-device" data-testid="public-review-device">
        <section className="public-review-heading">
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </section>
        <section className="public-review-device-state" aria-live="polite">
          <span>{copy.stateLabel}</span>
          <strong>{stateLabels[state]}</strong>
          <div className="public-review-device-figure" data-device-state={state} aria-hidden="true">
            <span />
          </div>
        </section>
        <div className="public-review-device-actions">
          <button disabled={connected} onClick={() => setState("idle")} type="button">
            {copy.connect}
          </button>
          <button disabled={!connected} onClick={() => setState("holding")} type="button">
            {copy.inflate}
          </button>
          <button disabled={!connected} onClick={() => setState("idle")} type="button">
            {copy.deflate}
          </button>
          <button disabled={!connected} onClick={() => setState("stopped")} type="button">
            {copy.stop}
          </button>
        </div>
        <a className="public-review-back-link" href="/operator.html">
          {copy.operatorLink}
        </a>
      </main>
    </ReviewShell>
  );
}

export function PublicHealthApp(): React.JSX.Element {
  const copy = PUBLIC_DEMO_COPY.review.health;
  return (
    <ReviewShell>
      <main className="public-review-health" data-testid="public-review-health">
        <span className="public-review-health-mark" aria-hidden="true">
          ✓
        </span>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <a href="/operator.html">{copy.operatorLink}</a>
      </main>
    </ReviewShell>
  );
}
