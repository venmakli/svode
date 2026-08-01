import { useEffect, useRef, useState } from "react";

import { loadActorActivity } from "../api/actors-api";
import type { ActorActivitySnapshot } from "../model/types";

type ActorActivityState =
  | { phase: "initial"; requestKey: string }
  | { error: string; phase: "error"; requestKey: string }
  | {
      phase: "ready";
      requestKey: string;
      snapshot: ActorActivitySnapshot;
    };

export function useActorActivity(spacePath: string, canonicalEmail: string) {
  const requestKey = `${spacePath}\0${canonicalEmail}`;
  const [state, setState] = useState<ActorActivityState>({
    phase: "initial",
    requestKey,
  });
  const requestIdRef = useRef(0);
  const currentState: ActorActivityState =
    state.requestKey === requestKey ? state : { phase: "initial", requestKey };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    void loadActorActivity(spacePath, canonicalEmail).then(
      (snapshot) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({ phase: "ready", requestKey, snapshot });
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({
          error:
            error instanceof Error && error.message
              ? error.message
              : typeof error === "string" && error
                ? error
                : "Unknown actor activity error",
          phase: "error",
          requestKey,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [canonicalEmail, requestKey, spacePath]);

  return currentState;
}
