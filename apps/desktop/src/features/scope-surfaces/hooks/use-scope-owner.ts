import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listenFileChanged,
  listenFileCreated,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import {
  getScopeOwnerFacts,
  isScopeOwnerNotFound,
} from "../api/owner-facts-api";
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
  gone: boolean;
}

/** This Desktop's structural operations over the Space of a target. */
export interface ScopeOwnerStructure {
  /** Changes with the content tree of the Space; a change rechecks the owner. */
  revision: unknown;
  /** Resolves once no structural operation over the Space is unfinished. */
  settled(): Promise<void>;
}

/**
 * The one resolver of scope owner identity and capabilities for main content
 * and Peek. `known` seeds a new target with facts the caller already holds;
 * `retainPrevious` keeps the previous owner while a retargeted path resolves.
 * `gone` confirms that the resolved owner is no longer at the target: Svode
 * answered that it is not found once the structural operations of
 * `structure` finished, since an own rename or move leaves the old path too.
 * The owner stays meanwhile; other failures are an `error`.
 */
export function useScopeOwner(input: {
  target: ScopeOwnerTarget | null;
  known?: ScopeOwnerFacts | null;
  retainPrevious?: boolean;
  structure?: ScopeOwnerStructure;
}) {
  const { target, known = null, retainPrevious = false, structure } = input;
  const spaceId = target?.spaceId;
  const spacePath = target?.spacePath;
  const projectPath = target?.projectPath;
  const path = target?.path;
  const key = target ? `${target.spaceId}\n${target.spacePath}\n${path}` : null;
  const [readRevision, setReadRevision] = useState(0);
  const [state, setState] = useState<ScopeOwnerState>({
    key,
    facts: known,
    error: null,
    gone: false,
  });
  let current = state;
  if (state.key !== key) {
    current = {
      key,
      facts: known ?? (retainPrevious && key ? state.facts : null),
      error: null,
      gone: false,
    };
    setState(current);
  }
  const revision = structure?.revision;
  const structureRef = useRef(structure);
  useEffect(() => {
    structureRef.current = structure;
  }, [structure]);
  const factsRef = useRef(current.facts);
  useEffect(() => {
    factsRef.current = current.facts;
  }, [current.facts]);
  const retry = useCallback(() => setReadRevision((value) => value + 1), []);

  useEffect(() => {
    if (key === null || spacePath === undefined || path === undefined) return;
    let disposed = false;
    const read = async (confirming: boolean): Promise<void> => {
      let facts: ScopeOwnerFacts;
      try {
        facts = await getScopeOwnerFacts({ spacePath, path });
      } catch (error: unknown) {
        if (disposed) return;
        // Only an owner that was there can vanish; an unknown target that is
        // not found is a failure to open it.
        if (isScopeOwnerNotFound(error) && factsRef.current) {
          if (!confirming) {
            // An own rename or move retargets the content before it ends.
            await structureRef.current?.settled();
            if (!disposed) return read(true);
            return;
          }
          setState((previous) =>
            previous.key !== key
              ? previous
              : { ...previous, error: null, gone: true },
          );
          return;
        }
        setState((previous) =>
          previous.key !== key
            ? previous
            : { ...previous, error: String(error) },
        );
        return;
      }
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
              gone: false,
            },
      );
    };
    void read(false);
    return () => {
      disposed = true;
    };
  }, [key, path, revision, spacePath, readRevision]);

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
  return { owner, error: current.error, gone: current.gone, retry };
}
