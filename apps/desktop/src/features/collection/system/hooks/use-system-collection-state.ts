import { useCallback, useMemo, useState } from "react";

import {
  createSystemCollectionInstanceState,
  normalizeSystemCollectionInstanceState,
  queryForSystemCollectionPresentation,
  setSystemCollectionPresentationQuery,
  useSystemCollectionSessionQueryState,
  type SystemCollectionStoredInstanceState,
} from "../model/query-state";
import { resolveSystemCollectionPresentationId } from "../model/instance-runtime";
import type {
  SystemCollectionInstance,
  SystemCollectionQueryState,
} from "../model/types";

export function useSystemCollectionState(instance: SystemCollectionInstance) {
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

  const activePresentationId = normalized.activePresentationId;
  return {
    activePresentationId,
    dismissResetWarning,
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
