import { useCallback, useEffect, useMemo, useState } from "react";
import { experimentApi } from "../shared/api.js";
import {
  EMPTY_PARTICIPANT_SNAPSHOT,
  parseParticipantSnapshot,
  type ExperimentPhase,
  type ParticipantSnapshot,
} from "../shared/model.js";
import { useRealtime } from "../shared/realtime.js";
import { ParticipantView } from "./ParticipantView.js";

function phaseFallback(snapshot: ParticipantSnapshot, phase: ExperimentPhase): ParticipantSnapshot {
  return { ...snapshot, phase };
}

export function ParticipantScreen({ displayToken }: { readonly displayToken: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ParticipantSnapshot>(EMPTY_PARTICIPANT_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let current = true;
    void experimentApi.getDisplay(displayToken).then((next) => {
      if (!current) return;
      setSnapshot(next);
      setLoaded(true);
    }).catch(() => {
      if (!current) return;
      setSnapshot((previous) => phaseFallback(previous, "error"));
      setLoaded(true);
    });
    return () => { current = false; };
  }, [displayToken]);

  const onMessage = useCallback((type: string, payload: unknown): boolean => {
    if (type === "session.snapshot" || type === "session.phaseChanged") {
      const parsed = parseParticipantSnapshot(payload);
      if (parsed === null) return false;
      setSnapshot(parsed);
      return true;
    }
    const terminalPhase: Partial<Record<string, ExperimentPhase>> = {
      "session.completed": "completed",
      "session.aborted": "aborted",
      "session.error": "error",
    };
    const phase = terminalPhase[type];
    if (phase !== undefined) {
      const parsed = parseParticipantSnapshot(payload);
      setSnapshot((previous) => parsed ?? phaseFallback(previous, phase));
    }
    return true;
  }, []);

  const socketQuery = useMemo(() => `displayToken=${encodeURIComponent(displayToken)}`, [displayToken]);
  const realtime = useRealtime({
    query: socketQuery,
    enabled: loaded,
    onMessage,
    announceDisplay: true,
  });
  const visibleSnapshot = !loaded || realtime.status !== "open" || !realtime.synchronized
    ? phaseFallback(snapshot, "recovery")
    : snapshot;

  return <ParticipantView snapshot={visibleSnapshot} />;
}
