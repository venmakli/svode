import { useEffect, useRef, useState } from "react";
import {
  ArtifactResolutionSession,
  type ArtifactRegistry,
  type ArtifactResolution,
} from "../model/registry";
import type { ActiveArtifactOpenRequest } from "../model/types";

interface ArtifactResolutionState<TSurface> {
  registry: ArtifactRegistry<TSurface>;
  requestKey: number;
  resolution: ArtifactResolution<TSurface> | null;
}

export function useArtifactResolution<TSurface>(
  registry: ArtifactRegistry<TSurface>,
  request: ActiveArtifactOpenRequest,
  options: { retainPreviousResolution?: boolean } = {},
) {
  const sessionRef = useRef(new ArtifactResolutionSession());
  const [state, setState] = useState<ArtifactResolutionState<TSurface>>({
    registry,
    requestKey: request.key,
    resolution: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const session = sessionRef.current;
    void session
      .resolve(registry, request.intent.target, controller.signal)
      .then((result) => {
        if (result.status !== "current" || controller.signal.aborted) return;
        setState({
          registry,
          requestKey: request.key,
          resolution: result.resolution,
        });
      });
    return () => {
      controller.abort();
      session.invalidate();
    };
  }, [registry, request]);

  if (state.registry !== registry) return null;
  return state.requestKey === request.key || options.retainPreviousResolution
    ? state.resolution
    : null;
}
