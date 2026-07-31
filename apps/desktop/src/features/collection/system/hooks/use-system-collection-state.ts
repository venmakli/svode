import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createSystemCollectionInstanceState,
  normalizeSystemCollectionInstanceState,
  queryForSystemCollectionPresentation,
  setSystemCollectionPresentationQuery,
  useSystemCollectionSessionQueryState,
  type SystemCollectionStoredInstanceState,
} from "../model/query-state";
import {
  SystemCollectionInstanceRegistry,
  resolveSystemCollectionPresentationId,
  validateSystemCollectionInstance,
} from "../model/instance-runtime";
import type {
  SystemCollectionInstance,
  SystemCollectionQueryState,
} from "../model/types";

const mountedSystemCollectionInstances = new SystemCollectionInstanceRegistry();

export type SystemCollectionStateController =
  | {
      diagnostics: readonly string[];
      phase: "blocking_error";
    }
  | {
      activePresentationId: string | null;
      dismissResetWarning(presentationId: string): void;
      phase: "ready";
      query: SystemCollectionQueryState;
      queryByPresentationId: Readonly<
        Record<string, SystemCollectionQueryState>
      >;
      resetWarning: boolean;
      setActivePresentationId(presentationId: string): void;
      setQuery(presentationId: string, query: SystemCollectionQueryState): void;
    };

export function useSystemCollectionState(
  instance: SystemCollectionInstance,
): SystemCollectionStateController {
  const validation = useMemo(
    () => validateSystemCollectionInstance(instance),
    [instance],
  );
  const getMountedCount = useCallback(
    () => mountedSystemCollectionInstances.getCount(instance.instanceKey),
    [instance.instanceKey],
  );
  const mountedCount = useSyncExternalStore(
    mountedSystemCollectionInstances.subscribe,
    getMountedCount,
    () => 0,
  );
  useEffect(() => {
    if (!validation.valid) {
      return;
    }

    const registration = mountedSystemCollectionInstances.register(
      instance.instanceKey,
    );
    return () => registration.release();
  }, [instance.instanceKey, validation.valid]);

  const emptyState = useMemo(() => createSystemCollectionInstanceState(), []);
  const sessionState = useSystemCollectionSessionQueryState(
    (state) => state.stateByInstanceKey[instance.instanceKey],
  );
  const setSessionState = useSystemCollectionSessionQueryState(
    (state) => state.setInstanceState,
  );
  const [lifecycleStateByInstanceKey, setLifecycleStateByInstanceKey] =
    useState<Readonly<Record<string, SystemCollectionStoredInstanceState>>>({});
  const lifecycleState =
    lifecycleStateByInstanceKey[instance.instanceKey] ?? emptyState;
  const stored =
    instance.stateScope === "session"
      ? (sessionState ?? emptyState)
      : lifecycleState;
  const normalized = useMemo(
    () => normalizeSystemCollectionInstanceState(instance, stored),
    [instance, stored],
  );

  const updateStored = useCallback(
    (
      update:
        | SystemCollectionStoredInstanceState
        | ((
            current: SystemCollectionStoredInstanceState,
          ) => SystemCollectionStoredInstanceState),
    ) => {
      if (instance.stateScope === "session") {
        const current =
          useSystemCollectionSessionQueryState.getState().stateByInstanceKey[
            instance.instanceKey
          ] ?? emptyState;
        const base = normalizeSystemCollectionInstanceState(instance, current);
        const next = typeof update === "function" ? update(base) : update;
        setSessionState(
          instance.instanceKey,
          normalizeSystemCollectionInstanceState(instance, next),
        );
      } else {
        setLifecycleStateByInstanceKey((currentByInstanceKey) => {
          const current =
            currentByInstanceKey[instance.instanceKey] ?? emptyState;
          const base = normalizeSystemCollectionInstanceState(
            instance,
            current,
          );
          const next = typeof update === "function" ? update(base) : update;
          const normalizedNext = normalizeSystemCollectionInstanceState(
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
        activePresentationId: resolveSystemCollectionPresentationId(
          instance,
          presentationId,
        ),
      }));
    },
    [instance, updateStored],
  );

  const setQuery = useCallback(
    (presentationId: string, query: SystemCollectionQueryState) => {
      updateStored((current) =>
        setSystemCollectionPresentationQuery(
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
      `System Collection instanceKey "${instance.instanceKey}" is mounted more than once.`,
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
    query: queryForSystemCollectionPresentation(
      normalized,
      activePresentationId,
    ),
    queryByPresentationId: normalized.queryByPresentationId,
    resetWarning: Boolean(
      activePresentationId &&
      normalized.resetWarningByPresentationId[activePresentationId],
    ),
    setActivePresentationId,
    setQuery,
  };
}
