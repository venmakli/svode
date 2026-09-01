import { create } from "zustand";

import { resolveCollectionPresentationId } from "./instance-runtime";
import { EMPTY_COLLECTION_QUERY, validateCollectionQuery } from "./query";
import { readCollectionPresentationRuntime } from "./runtime";
import type { CollectionInstance, CollectionQueryState } from "./types";

export interface CollectionStoredInstanceState {
  activePresentationId: string | null;
  queryByPresentationId: Readonly<Record<string, CollectionQueryState>>;
  resetWarningByPresentationId: Readonly<Record<string, boolean>>;
}

interface CollectionSessionQueryState {
  stateByInstanceKey: Readonly<Record<string, CollectionStoredInstanceState>>;
  setInstanceState(
    instanceKey: string,
    state: CollectionStoredInstanceState,
  ): void;
  clearInstanceState(instanceKey: string): void;
}

export function createCollectionInstanceState(
  activePresentationId: string | null = null,
): CollectionStoredInstanceState {
  return {
    activePresentationId,
    queryByPresentationId: {},
    resetWarningByPresentationId: {},
  };
}

export function normalizeCollectionInstanceState(
  instance: CollectionInstance,
  stored: CollectionStoredInstanceState,
): CollectionStoredInstanceState {
  const activePresentationId = resolveCollectionPresentationId(
    instance,
    stored.activePresentationId,
  );
  const available = new Map(
    instance.presentations.map((runtime) => {
      const { descriptor } =
        readCollectionPresentationRuntime(runtime).instance;
      return [descriptor.id, descriptor] as const;
    }),
  );
  let changed = activePresentationId !== stored.activePresentationId;
  const queryByPresentationId: Record<string, CollectionQueryState> = {};
  const resetWarningByPresentationId: Record<string, boolean> = {};

  for (const [presentationId, query] of Object.entries(
    stored.queryByPresentationId,
  )) {
    const descriptor = available.get(presentationId);
    if (!descriptor) {
      changed = true;
      continue;
    }
    const validation = validateCollectionQuery(descriptor, query);
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

export function setCollectionPresentationQuery(
  instance: CollectionInstance,
  stored: CollectionStoredInstanceState,
  presentationId: string,
  query: CollectionQueryState,
): CollectionStoredInstanceState {
  const runtime = instance.presentations.find(
    (candidate) =>
      readCollectionPresentationRuntime(candidate).instance.descriptor.id ===
      presentationId,
  );
  if (!runtime) {
    return normalizeCollectionInstanceState(instance, stored);
  }
  const { descriptor } = readCollectionPresentationRuntime(runtime).instance;
  const validation = validateCollectionQuery(descriptor, query);
  return normalizeCollectionInstanceState(instance, {
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

export function queryForCollectionPresentation(
  stored: CollectionStoredInstanceState,
  presentationId: string | null,
): CollectionQueryState {
  return (
    (presentationId
      ? stored.queryByPresentationId[presentationId]
      : undefined) ?? EMPTY_COLLECTION_QUERY
  );
}

export const useCollectionSessionQueryState =
  create<CollectionSessionQueryState>((set) => ({
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

export function useCollectionActivePresentationId(
  instanceKey: string | null,
): string | null {
  return useCollectionSessionQueryState((state) =>
    instanceKey
      ? (state.stateByInstanceKey[instanceKey]?.activePresentationId ?? null)
      : null,
  );
}
