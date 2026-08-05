import { create } from "zustand";

import { resolveSystemCollectionPresentationId } from "./instance-runtime";
import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  validateSystemCollectionQuery,
} from "./query";
import { readSystemCollectionPresentationRuntime } from "./runtime";
import type {
  SystemCollectionInstance,
  SystemCollectionQueryState,
} from "./types";

export interface SystemCollectionStoredInstanceState {
  activePresentationId: string | null;
  queryByPresentationId: Readonly<Record<string, SystemCollectionQueryState>>;
  resetWarningByPresentationId: Readonly<Record<string, boolean>>;
}

interface SystemCollectionSessionQueryState {
  stateByInstanceKey: Readonly<
    Record<string, SystemCollectionStoredInstanceState>
  >;
  setInstanceState(
    instanceKey: string,
    state: SystemCollectionStoredInstanceState,
  ): void;
  clearInstanceState(instanceKey: string): void;
}

export function createSystemCollectionInstanceState(
  activePresentationId: string | null = null,
): SystemCollectionStoredInstanceState {
  return {
    activePresentationId,
    queryByPresentationId: {},
    resetWarningByPresentationId: {},
  };
}

export function normalizeSystemCollectionInstanceState(
  instance: SystemCollectionInstance,
  stored: SystemCollectionStoredInstanceState,
): SystemCollectionStoredInstanceState {
  const activePresentationId = resolveSystemCollectionPresentationId(
    instance,
    stored.activePresentationId,
  );
  const available = new Map(
    instance.presentations.map((runtime) => {
      const { descriptor } =
        readSystemCollectionPresentationRuntime(runtime).instance;
      return [descriptor.id, descriptor] as const;
    }),
  );
  let changed = activePresentationId !== stored.activePresentationId;
  const queryByPresentationId: Record<string, SystemCollectionQueryState> = {};
  const resetWarningByPresentationId: Record<string, boolean> = {};

  for (const [presentationId, query] of Object.entries(
    stored.queryByPresentationId,
  )) {
    const descriptor = available.get(presentationId);
    if (!descriptor) {
      changed = true;
      continue;
    }
    const validation = validateSystemCollectionQuery(descriptor, query);
    queryByPresentationId[presentationId] = validation.query;
    if (validation.query !== query) {
      changed = true;
    }
    if (validation.reset) {
      resetWarningByPresentationId[presentationId] = true;
    }
  }

  for (const presentationId of Object.keys(
    stored.resetWarningByPresentationId,
  )) {
    if (available.has(presentationId)) {
      resetWarningByPresentationId[presentationId] = true;
    } else {
      changed = true;
    }
  }

  if (!changed) {
    return stored;
  }
  return {
    activePresentationId,
    queryByPresentationId,
    resetWarningByPresentationId,
  };
}

export function setSystemCollectionPresentationQuery(
  instance: SystemCollectionInstance,
  stored: SystemCollectionStoredInstanceState,
  presentationId: string,
  query: SystemCollectionQueryState,
): SystemCollectionStoredInstanceState {
  const runtime = instance.presentations.find(
    (candidate) =>
      readSystemCollectionPresentationRuntime(candidate).instance.descriptor
        .id === presentationId,
  );
  if (!runtime) {
    return normalizeSystemCollectionInstanceState(instance, stored);
  }
  const { descriptor } =
    readSystemCollectionPresentationRuntime(runtime).instance;
  const validation = validateSystemCollectionQuery(descriptor, query);
  return normalizeSystemCollectionInstanceState(instance, {
    ...stored,
    queryByPresentationId: {
      ...stored.queryByPresentationId,
      [presentationId]: validation.query,
    },
    resetWarningByPresentationId: {
      ...stored.resetWarningByPresentationId,
      ...(validation.reset ? { [presentationId]: true } : {}),
    },
  });
}

export function queryForSystemCollectionPresentation(
  stored: SystemCollectionStoredInstanceState,
  presentationId: string | null,
): SystemCollectionQueryState {
  return (
    (presentationId
      ? stored.queryByPresentationId[presentationId]
      : undefined) ?? EMPTY_SYSTEM_COLLECTION_QUERY
  );
}

export const useSystemCollectionSessionQueryState =
  create<SystemCollectionSessionQueryState>((set) => ({
    stateByInstanceKey: {},
    setInstanceState: (instanceKey, state) =>
      set((current) => ({
        stateByInstanceKey: {
          ...current.stateByInstanceKey,
          [instanceKey]: state,
        },
      })),
    clearInstanceState: (instanceKey) =>
      set((current) => {
        if (!(instanceKey in current.stateByInstanceKey)) {
          return current;
        }
        const stateByInstanceKey = { ...current.stateByInstanceKey };
        delete stateByInstanceKey[instanceKey];
        return { stateByInstanceKey };
      }),
  }));

export function useSystemCollectionActivePresentationId(
  instanceKey: string | null,
): string | null {
  return useSystemCollectionSessionQueryState((state) =>
    instanceKey
      ? (state.stateByInstanceKey[instanceKey]?.activePresentationId ?? null)
      : null,
  );
}
