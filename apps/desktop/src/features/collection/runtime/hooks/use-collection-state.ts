import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createCollectionInstanceState,
  normalizeCollectionInstanceState,
  queryForCollectionPresentation,
  setCollectionPresentationQuery,
  useCollectionSessionQueryState,
  type CollectionStoredInstanceState,
} from "../model/query-state";
import {
  CollectionInstanceRegistry,
  resolveCollectionPresentationId,
  validateCollectionInstance,
} from "../model/instance-runtime";
import type { CollectionInstance, CollectionQueryState } from "../model/types";

const mountedCollectionInstances = new CollectionInstanceRegistry();

export type CollectionStateController =
  | {
      diagnostics: readonly string[];
      phase: "blocking_error";
    }
  | {
      activePresentationId: string | null;
      dismissResetWarning(presentationId: string): void;
      phase: "ready";
      query: CollectionQueryState;
      queryByPresentationId: Readonly<Record<string, CollectionQueryState>>;
      resetWarning: boolean;
      setActivePresentationId(presentationId: string): void;
      setQuery(presentationId: string, query: CollectionQueryState): void;
    };

export function useCollectionState(
  instance: CollectionInstance,
): CollectionStateController {
  const validation = useMemo(
    () => validateCollectionInstance(instance),
    [instance],
  );
  const getMountedCount = useCallback(
    () => mountedCollectionInstances.getCount(instance.instanceKey),
    [instance.instanceKey],
  );
  const mountedCount = useSyncExternalStore(
    mountedCollectionInstances.subscribe,
    getMountedCount,
    () => 0,
  );
  useEffect(() => {
    if (!validation.valid) {
      return;
    }

    const registration = mountedCollectionInstances.register(
      instance.instanceKey,
    );
    return () => registration.release();
  }, [instance.instanceKey, validation.valid]);

  const emptyState = useMemo(() => createCollectionInstanceState(), []);
  const sessionState = useCollectionSessionQueryState(
    (state) => state.stateByInstanceKey[instance.instanceKey],
  );
  const setSessionState = useCollectionSessionQueryState(
    (state) => state.setInstanceState,
  );
  const [lifecycleStateByInstanceKey, setLifecycleStateByInstanceKey] =
    useState<Readonly<Record<string, CollectionStoredInstanceState>>>({});
  const lifecycleState =
    lifecycleStateByInstanceKey[instance.instanceKey] ?? emptyState;
  const stored =
    instance.stateScope === "session"
      ? (sessionState ?? emptyState)
      : lifecycleState;
  const normalized = useMemo(
    () => normalizeCollectionInstanceState(instance, stored),
    [instance, stored],
  );

  const updateStored = useCallback(
    (
      update:
        | CollectionStoredInstanceState
        | ((
            current: CollectionStoredInstanceState,
          ) => CollectionStoredInstanceState),
    ) => {
      if (instance.stateScope === "session") {
        const current =
          useCollectionSessionQueryState.getState().stateByInstanceKey[
            instance.instanceKey
          ] ?? emptyState;
        const base = normalizeCollectionInstanceState(instance, current);
        const next = typeof update === "function" ? update(base) : update;
        setSessionState(
          instance.instanceKey,
          normalizeCollectionInstanceState(instance, next),
        );
      } else {
        setLifecycleStateByInstanceKey((currentByInstanceKey) => {
          const current =
            currentByInstanceKey[instance.instanceKey] ?? emptyState;
          const base = normalizeCollectionInstanceState(instance, current);
          const next = typeof update === "function" ? update(base) : update;
          const normalizedNext = normalizeCollectionInstanceState(
            instance,
            next,
          );
          return {
            ...currentByInstanceKey,
            [instance.instanceKey]: normalizedNext,
          };
        });
      }
    },
    [emptyState, instance, setSessionState],
  );

  const setActivePresentationId = useCallback(
    (presentationId: string) => {
      updateStored((current) => ({
        ...current,
        activePresentationId: resolveCollectionPresentationId(
          instance,
          presentationId,
        ),
      }));
    },
    [instance, updateStored],
  );

  const setQuery = useCallback(
    (presentationId: string, query: CollectionQueryState) => {
      updateStored((current) =>
        setCollectionPresentationQuery(
          instance,
          current,
          presentationId,
          query,
        ),
      );
    },
    [instance, updateStored],
  );

  const dismissResetWarning = useCallback(
    (presentationId: string) => {
      updateStored((current) => {
        if (!current.resetWarningByPresentationId[presentationId]) {
          return current;
        }
        const resetWarningByPresentationId = {
          ...current.resetWarningByPresentationId,
        };
        delete resetWarningByPresentationId[presentationId];
        return { ...current, resetWarningByPresentationId };
      });
    },
    [updateStored],
  );

  const diagnostics = validation.diagnostics.map(({ message }) => message);
  if (mountedCount > 1) {
    diagnostics.push(
      `Collection instanceKey "${instance.instanceKey}" is mounted more than once.`,
    );
  }
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      phase: "blocking_error",
    };
  }

  const activePresentationId = normalized.activePresentationId;
  return {
    activePresentationId,
    dismissResetWarning,
    phase: "ready",
    query: queryForCollectionPresentation(normalized, activePresentationId),
    queryByPresentationId: normalized.queryByPresentationId,
    resetWarning: Boolean(
      activePresentationId &&
      normalized.resetWarningByPresentationId[activePresentationId],
    ),
    setActivePresentationId,
    setQuery,
  };
}
