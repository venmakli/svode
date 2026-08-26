import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadRoutineAutomaticConsent,
  updateRoutineAutomaticConsent,
  type RoutineOwnerInput,
} from "../api/routines-api";
import type { RoutineResolvedOwnerKind } from "../model/types";
import { routineErrorMessage } from "./use-routine-catalog";

interface RoutineAutomaticConsentState {
  ownerKey: string;
  enabled: boolean | null;
  error: string | null;
  loading: boolean;
  pending: boolean;
  storageResetPending: boolean;
}

export function useRoutineAutomaticConsent(owner: RoutineOwnerInput) {
  const commandOwner = useMemo<RoutineOwnerInput>(
    () => ({
      ownerKind: owner.ownerKind,
      ownerPath: owner.ownerPath,
      projectPath: owner.projectPath,
      spaceId: owner.spaceId,
      spacePath: owner.spacePath,
    }),
    [
      owner.ownerKind,
      owner.ownerPath,
      owner.projectPath,
      owner.spaceId,
      owner.spacePath,
    ],
  );
  const ownerKey = automaticConsentOwnerKey(commandOwner);
  const requestIdRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const stateRef = useRef<RoutineAutomaticConsentState>(initialState(ownerKey));
  const [state, setStateValue] = useState<RoutineAutomaticConsentState>(() =>
    initialState(ownerKey),
  );
  const commitState = useCallback((next: RoutineAutomaticConsentState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    void loadRoutineAutomaticConsent(commandOwner).then(
      (consent) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        commitState({
          ownerKey,
          enabled: consent.enabled,
          error: null,
          loading: false,
          pending: false,
          storageResetPending: consent.storageResetPending,
        });
      },
      (error: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        commitState({
          ownerKey,
          enabled: null,
          error: routineErrorMessage(error),
          loading: false,
          pending: false,
          storageResetPending: false,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [commandOwner, commitState, ownerKey, reloadToken]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const confirmed = stateRef.current;
      if (
        confirmed.ownerKey !== ownerKey ||
        confirmed.enabled === null ||
        confirmed.pending ||
        confirmed.enabled === enabled
      ) {
        return;
      }

      const requestId = ++requestIdRef.current;
      commitState({
        ...confirmed,
        error: null,
        pending: true,
      });
      try {
        const consent = await updateRoutineAutomaticConsent(
          commandOwner,
          enabled,
        );
        if (requestId !== requestIdRef.current) return;
        commitState({
          ownerKey,
          enabled: consent.enabled,
          error: null,
          loading: false,
          pending: false,
          storageResetPending: consent.storageResetPending,
        });
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        const message = routineErrorMessage(error);
        let canonicalEnabled = confirmed.enabled;
        let canonicalStorageResetPending = confirmed.storageResetPending;
        try {
          const canonical = await loadRoutineAutomaticConsent(commandOwner);
          canonicalEnabled = canonical.enabled;
          canonicalStorageResetPending = canonical.storageResetPending;
        } catch {
          // The last confirmed value remains authoritative for this mounted owner.
        }
        if (requestId !== requestIdRef.current) return;
        commitState({
          ownerKey,
          enabled: canonicalEnabled,
          error: message,
          loading: false,
          pending: false,
          storageResetPending: canonicalStorageResetPending,
        });
      }
    },
    [commandOwner, commitState, ownerKey],
  );

  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.ownerKey !== ownerKey || current.loading || current.pending) {
      return;
    }

    requestIdRef.current += 1;
    commitState(initialState(ownerKey));
    setReloadToken((token) => token + 1);
  }, [commitState, ownerKey, setReloadToken]);

  const visibleState =
    state.ownerKey === ownerKey ? state : initialState(ownerKey);
  return {
    ...visibleState,
    ownerKind: resolvedOwnerKind(commandOwner),
    retry,
    setEnabled,
  };
}

function initialState(ownerKey: string): RoutineAutomaticConsentState {
  return {
    ownerKey,
    enabled: null,
    error: null,
    loading: true,
    pending: false,
    storageResetPending: false,
  };
}

function automaticConsentOwnerKey(owner: RoutineOwnerInput) {
  return [
    owner.projectPath,
    owner.spacePath,
    owner.spaceId,
    owner.ownerKind,
    owner.ownerPath,
  ].join("\0");
}

function resolvedOwnerKind(owner: RoutineOwnerInput): RoutineResolvedOwnerKind {
  if (owner.ownerKind === "collection_directory") return "collection";
  return owner.projectPath === owner.spacePath ? "project" : "space";
}
