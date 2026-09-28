import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import { getScopeOwnerFacts } from "../api/owner-facts-api";
import {
  affectsScopeOwnerFacts,
  createScopeOwner,
  sameScopeOwnerFacts,
  type ScopeOwnerFacts,
  type ScopeOwnerTarget,
} from "../model/owner-facts";

interface ScopeOwnerState {
  key: string | null;
  facts: ScopeOwnerFacts | null;
  error: string | null;
}

/**
 * The one resolver of scope owner identity and capabilities for main content
 * and Peek. `known` seeds a new target with facts the caller already holds;
 * `retainPrevious` keeps the previous owner while a retargeted path resolves.
 */
export function useScopeOwner(input: {
  target: ScopeOwnerTarget | null;
  known?: ScopeOwnerFacts | null;
  retainPrevious?: boolean;
}) {
  const { target, known = null, retainPrevious = false } = input;
  const spaceId = target?.spaceId;
  const spacePath = target?.spacePath;
  const projectPath = target?.projectPath;
  const path = target?.path;
  const key = target ? `${target.spaceId}\n${target.spacePath}\n${path}` : null;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ScopeOwnerState>({
    key,
    facts: known,
    error: null,
  });
  let current = state;
  if (state.key !== key) {
    current = {
      key,
      facts: known ?? (retainPrevious && key ? state.facts : null),
      error: null,
    };
    setState(current);
  }
  const factsRef = useRef(current.facts);
  useEffect(() => {
    factsRef.current = current.facts;
  }, [current.facts]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (key === null || spacePath === undefined || path === undefined) return;
    let disposed = false;
    void getScopeOwnerFacts({ spacePath, path })
      .then((facts) => {
        if (disposed) return;
        setState((previous) =>
          previous.key !== key
            ? previous
            : {
                key,
                facts:
                  previous.facts && sameScopeOwnerFacts(previous.facts, facts)
                    ? previous.facts
                    : facts,
                error: null,
              },
        );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState((previous) =>
          previous.key !== key
            ? previous
            : { ...previous, error: String(error) },
        );
      });
    return () => {
      disposed = true;
    };
  }, [key, path, revision, spacePath]);

  useEffect(() => {
    if (spacePath === undefined || path === undefined) return;
    const refresh = (event: { space?: string; path: string }) => {
      if (event.space && event.space !== spacePath) return;
      if (affectsScopeOwnerFacts(path, factsRef.current, event.path)) retry();
    };
    const listeners = [
      listenFileCreated(refresh),
      listenFileChanged(refresh),
      listenFileDeleted(refresh),
    ];
    return () => {
      for (const listener of listeners)
        void listener.then((unlisten) => unlisten());
    };
  }, [path, retry, spacePath]);

  const facts = current.facts;
  const owner = useMemo(
    () =>
      facts && spaceId && spacePath && projectPath
        ? createScopeOwner({ spaceId, spacePath, projectPath }, facts)
        : null,
    [facts, projectPath, spaceId, spacePath],
  );
  return { owner, error: current.error, retry };
}
