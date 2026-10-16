import { useEffect, useState } from "react";
import type { ActorCandidate } from "@/features/properties";

type RequestActors = (allTime?: boolean) => Promise<ActorCandidate[]>;

export type ActorCandidatesRequestStatus =
  | "idle"
  | "pending"
  | "settled"
  | "rejected";

// Requests candidates when the filter value editor is shown; a response that
// arrives after unmount or a source change is ignored.
export function useActorCandidatesRequest(onRequestActors?: RequestActors) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    source: RequestActors;
    attempt: number;
    status: "settled" | "rejected";
  } | null>(null);

  useEffect(() => {
    if (!onRequestActors) return;
    let active = true;
    onRequestActors().then(
      () => {
        if (active) {
          setResult({ source: onRequestActors, attempt, status: "settled" });
        }
      },
      (error: unknown) => {
        console.error("Failed to load actor filter candidates:", error);
        if (active) {
          setResult({ source: onRequestActors, attempt, status: "rejected" });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, onRequestActors]);

  let status: ActorCandidatesRequestStatus = "idle";
  if (onRequestActors) {
    status =
      result?.source === onRequestActors && result.attempt === attempt
        ? result.status
        : "pending";
  }

  return { status, retry: () => setAttempt((current) => current + 1) };
}
