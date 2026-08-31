import { create } from "zustand";

import { resolveCollectionCorePresentationId } from "./instance-runtime";
import {
  EMPTY_COLLECTION_CORE_QUERY,
  validateCollectionCoreQuery,
} from "./query";
import { readCollectionCorePresentationRuntime } from "./runtime";
import type { CollectionCoreInstance, CollectionCoreQueryState } from "./types";

export interface CollectionCoreStoredInstanceState {
  activePresentationId: string | null;
  queryByPresentationId: Readonly<Record<string, CollectionCoreQueryState>>;
  resetWarningByPresentationId: Readonly<Record<string, boolean>>;
}

interface CollectionCoreSessionQueryState {
  stateByInstanceKey: Readonly<
    Record<string, CollectionCoreStoredInstanceState>
  >;
  setInstanceState(
    instanceKey: string,
    state: CollectionCoreStoredInstanceState,
  ): void;
  clearInstanceState(instanceKey: string): void;
}

export function createCollectionCoreInstanceState(
  activePresentationId: string | null = null,
): CollectionCoreStoredInstanceState {
  return {
    activePresentationId,
    queryByPresentationId: {},
    resetWarningByPresentationId: {},
  };
}

export function normalizeCollectionCoreInstanceState(
  instance: CollectionCoreInstance,
  stored: CollectionCoreStoredInstanceState,
): CollectionCoreStoredInstanceState {
  const activePresentationId = resolveCollectionCorePresentationId(
    instance,
    stored.activePresentationId,
  );
  const available = new Map(
    instance.presentations.map((runtime) => {
      const { descriptor } =
        readCollectionCorePresentationRuntime(runtime).instance;
      return [descriptor.id, descriptor] as const;
    }),
  );
  let changed = activePresentationId !== stored.activePresentationId;
  const queryByPresentationId: Record<string, CollectionCoreQueryState> = {};
  const resetWarningByPresentationId: Record<string, boolean> = {};

  for (const [presentationId, query] of Object.entries(
    stored.queryByPresentationId,
  )) {
    const descriptor = available.get(presentationId);
    if (!descriptor) {
      changed = true;
      continue;
    }
    const validation = validateCollectionCoreQuery(descriptor, query);
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

export function setCollectionCorePresentationQuery(
  instance: CollectionCoreInstance,
  stored: CollectionCoreStoredInstanceState,
  presentationId: string,
  query: CollectionCoreQueryState,
): CollectionCoreStoredInstanceState {
  const runtime = instance.presentations.find(
    (candidate) =>
      readCollectionCorePresentationRuntime(candidate).instance.descriptor
        .id === presentationId,
  );
  if (!runtime) {
    return normalizeCollectionCoreInstanceState(instance, stored);
  }
  const { descriptor } =
    readCollectionCorePresentationRuntime(runtime).instance;
  const validation = validateCollectionCoreQuery(descriptor, query);
  return normalizeCollectionCoreInstanceState(instance, {
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

export function queryForCollectionCorePresentation(
  stored: CollectionCoreStoredInstanceState,
  presentationId: string | null,
): CollectionCoreQueryState {
  return (
    (presentationId
      ? stored.queryByPresentationId[presentationId]
      : undefined) ?? EMPTY_COLLECTION_CORE_QUERY
  );
}

export const useCollectionCoreSessionQueryState =
  create<CollectionCoreSessionQueryState>((set) => ({
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

export function useCollectionCoreActivePresentationId(
  instanceKey: string | null,
): string | null {
  return useCollectionCoreSessionQueryState((state) =>
    instanceKey
      ? (state.stateByInstanceKey[instanceKey]?.activePresentationId ?? null)
      : null,
  );
}
