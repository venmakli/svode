import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createCollectionCoreInstanceState,
  normalizeCollectionCoreInstanceState,
  queryForCollectionCorePresentation,
  setCollectionCorePresentationQuery,
  useCollectionCoreSessionQueryState,
  type CollectionCoreStoredInstanceState,
} from "../model/query-state";
import {
  CollectionCoreInstanceRegistry,
  resolveCollectionCorePresentationId,
  validateCollectionCoreInstance,
} from "../model/instance-runtime";
import type {
  CollectionCoreInstance,
  CollectionCoreQueryState,
} from "../model/types";

const mountedCollectionCoreInstances = new CollectionCoreInstanceRegistry();

export type CollectionCoreStateController =
  | {
      diagnostics: readonly string[];
      phase: "blocking_error";
    }
  | {
      activePresentationId: string | null;
      dismissResetWarning(presentationId: string): void;
      phase: "ready";
      query: CollectionCoreQueryState;
      queryByPresentationId: Readonly<Record<string, CollectionCoreQueryState>>;
      resetWarning: boolean;
      setActivePresentationId(presentationId: string): void;
      setQuery(presentationId: string, query: CollectionCoreQueryState): void;
    };

export function useCollectionCoreState(
  instance: CollectionCoreInstance,
): CollectionCoreStateController {
  const validation = useMemo(
    () => validateCollectionCoreInstance(instance),
    [instance],
  );
  const getMountedCount = useCallback(
    () => mountedCollectionCoreInstances.getCount(instance.instanceKey),
    [instance.instanceKey],
  );
  const mountedCount = useSyncExternalStore(
    mountedCollectionCoreInstances.subscribe,
    getMountedCount,
    () => 0,
  );
  useEffect(() => {
    if (!validation.valid) {
      return;
    }

    const registration = mountedCollectionCoreInstances.register(
      instance.instanceKey,
    );
    return () => registration.release();
  }, [instance.instanceKey, validation.valid]);

  const emptyState = useMemo(() => createCollectionCoreInstanceState(), []);
  const sessionState = useCollectionCoreSessionQueryState(
    (state) => state.stateByInstanceKey[instance.instanceKey],
  );
  const setSessionState = useCollectionCoreSessionQueryState(
    (state) => state.setInstanceState,
  );
  const [lifecycleStateByInstanceKey, setLifecycleStateByInstanceKey] =
    useState<Readonly<Record<string, CollectionCoreStoredInstanceState>>>({});
  const lifecycleState =
    lifecycleStateByInstanceKey[instance.instanceKey] ?? emptyState;
  const stored =
    instance.stateScope === "session"
      ? (sessionState ?? emptyState)
      : lifecycleState;
  const normalized = useMemo(
    () => normalizeCollectionCoreInstanceState(instance, stored),
    [instance, stored],
  );

  const updateStored = useCallback(
    (
      update:
        | CollectionCoreStoredInstanceState
        | ((
            current: CollectionCoreStoredInstanceState,
          ) => CollectionCoreStoredInstanceState),
    ) => {
      if (instance.stateScope === "session") {
        const current =
          useCollectionCoreSessionQueryState.getState().stateByInstanceKey[
            instance.instanceKey
          ] ?? emptyState;
        const base = normalizeCollectionCoreInstanceState(instance, current);
        const next = typeof update === "function" ? update(base) : update;
        setSessionState(
          instance.instanceKey,
          normalizeCollectionCoreInstanceState(instance, next),
        );
      } else {
        setLifecycleStateByInstanceKey((currentByInstanceKey) => {
          const current =
            currentByInstanceKey[instance.instanceKey] ?? emptyState;
          const base = normalizeCollectionCoreInstanceState(instance, current);
          const next = typeof update === "function" ? update(base) : update;
          const normalizedNext = normalizeCollectionCoreInstanceState(
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
        activePresentationId: resolveCollectionCorePresentationId(
          instance,
          presentationId,
        ),
      }));
    },
    [instance, updateStored],
  );

  const setQuery = useCallback(
    (presentationId: string, query: CollectionCoreQueryState) => {
      updateStored((current) =>
        setCollectionCorePresentationQuery(
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
      `Collection Core instanceKey "${instance.instanceKey}" is mounted more than once.`,
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
    query: queryForCollectionCorePresentation(normalized, activePresentationId),
    queryByPresentationId: normalized.queryByPresentationId,
    resetWarning: Boolean(
      activePresentationId &&
      normalized.resetWarningByPresentationId[activePresentationId],
    ),
    setActivePresentationId,
    setQuery,
  };
}
