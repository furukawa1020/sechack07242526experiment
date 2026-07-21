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
  if (typeof BroadcastChannel !== "function") return null;

  try {
    return new BroadcastChannel(REVIEW_CHANNEL_NAME);
  } catch {
    return null;
  }
}

function postReviewMessage(channel: BroadcastChannel, message: ReviewMessage): boolean {
  try {
    channel.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function closeReviewChannel(channel: BroadcastChannel): void {
  try {
    channel.close();
  } catch {
    // A failed or already-closed review channel has no resource needed by the static demo.
  }
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
  const [channelState, setChannelState] = useState<"available" | "unsupported">(
    typeof BroadcastChannel === "function" ? "available" : "unsupported",
  );
  const stepRef = useRef(step);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    let active = true;
    const showUnsupported = (): void => {
      window.queueMicrotask(() => {
        if (active) setChannelState("unsupported");
      });
    };
    const channel = createReviewChannel();
    channelRef.current = channel;
    if (channel === null) {
      showUnsupported();
      return (): void => {
        active = false;
      };
    }

    const markUnsupported = (): void => {
      if (channelRef.current === channel) channelRef.current = null;
      closeReviewChannel(channel);
      showUnsupported();
    };

    channel.onmessage = (event: MessageEvent<unknown>): void => {
      const message = parseReviewMessage(event.data);
      if (message?.type === "review.ready") {
        const sent = postReviewMessage(channel, {
          type: "review.step",
          step: stepRef.current,
        } satisfies ReviewStepMessage);
        if (!sent) markUnsupported();
      }
    };
    const sent = postReviewMessage(channel, {
      type: "review.step",
      step: stepRef.current,
    } satisfies ReviewStepMessage);
    if (!sent) markUnsupported();

    return (): void => {
      active = false;
      if (channelRef.current === channel) channelRef.current = null;
      closeReviewChannel(channel);
    };
  }, []);

  useEffect(() => {
    stepRef.current = step;
    const channel = channelRef.current;
    if (channel === null) return;
    const sent = postReviewMessage(channel, {
      type: "review.step",
      step,
    } satisfies ReviewStepMessage);
    if (!sent) {
      channelRef.current = null;
      closeReviewChannel(channel);
      window.queueMicrotask(() => setChannelState("unsupported"));
    }
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
            <small data-review-channel-state={channelState}>
              {channelState === "unsupported"
                ? PUBLIC_DEMO_COPY.review.operator.unsupported
                : PUBLIC_DEMO_COPY.review.operator.connection}
            </small>
          </div>
        </section>

        <nav className="public-review-links" aria-label="公開レビュー画面">
          <a href="/display/demo/index.html" rel="noopener" target="_blank">
            {PUBLIC_DEMO_COPY.review.operator.displayLink}
          </a>
          <a href="/device-test/index.html">{PUBLIC_DEMO_COPY.review.operator.deviceLink}</a>
        </nav>
      </main>
    </ReviewShell>
  );
}

export function PublicDisplayApp(): React.JSX.Element {
  const [step, setStep] = useState(PUBLIC_DEMO_INTRO_STEP);
  const [connectionState, setConnectionState] = useState<"unsupported" | "waiting" | "connected">(
    typeof BroadcastChannel === "function" ? "waiting" : "unsupported",
  );

  useEffect(() => {
    let active = true;
    const showUnsupported = (): void => {
      window.queueMicrotask(() => {
        if (active) setConnectionState("unsupported");
      });
    };
    const channel = createReviewChannel();
    if (channel === null) {
      showUnsupported();
      return (): void => {
        active = false;
      };
    }

    channel.onmessage = (event: MessageEvent<unknown>): void => {
      const message = parseReviewMessage(event.data);
      if (message?.type === "review.step") {
        setStep(message.step);
        setConnectionState("connected");
      }
    };
    const sent = postReviewMessage(channel, { type: "review.ready" } satisfies ReviewReadyMessage);
    if (!sent) {
      closeReviewChannel(channel);
      showUnsupported();
      return (): void => {
        active = false;
      };
    }

    return (): void => {
      active = false;
      closeReviewChannel(channel);
    };
  }, []);

  return (
    <ReviewShell>
      <main
        className="public-review-display-stage"
        data-testid="public-review-display"
        aria-label="読み取り専用の参加者表示レビュー"
      >
        <Scene step={step} />
      </main>
      {connectionState === "connected" ? null : (
        <aside className="public-review-display-note" aria-live="polite">
          <p>
            {connectionState === "unsupported"
              ? PUBLIC_DEMO_COPY.review.display.unsupported
              : PUBLIC_DEMO_COPY.review.display.waiting}
          </p>
          {connectionState === "unsupported" ? (
            <a href="/">{PUBLIC_DEMO_COPY.review.display.manualLink}</a>
          ) : null}
        </aside>
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
  const operational = state === "idle" || state === "holding";

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
          <button disabled={!operational} onClick={() => setState("holding")} type="button">
            {copy.inflate}
          </button>
          <button disabled={!operational} onClick={() => setState("idle")} type="button">
            {copy.deflate}
          </button>
          <button disabled={!operational} onClick={() => setState("stopped")} type="button">
            {copy.stop}
          </button>
        </div>
        <a className="public-review-back-link" href="/operator/index.html">
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
        <a href="/operator/index.html">{copy.operatorLink}</a>
      </main>
    </ReviewShell>
  );
}
