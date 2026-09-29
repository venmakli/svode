import { useEffect, useMemo, useSyncExternalStore } from "react";
import { listAgentAdapterIdentities } from "../api/agent-adapters";
import {
  createAgentAdapterDictionary,
  type AgentAdapterDictionary,
  type AgentAdapterIdentity,
} from "../model/dictionary";

interface AgentAdapterIdentitiesSnapshot {
  identities: readonly AgentAdapterIdentity[] | null;
  failed: boolean;
}

let snapshot: AgentAdapterIdentitiesSnapshot = {
  identities: null,
  failed: false,
};
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setSnapshot(next: AgentAdapterIdentitiesSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

/**
 * Reads the adapter registry once for the app process; every agent label
 * shares the result. A failed read is retried by the next call.
 */
export function loadAgentAdapterIdentities(
  list: () => Promise<AgentAdapterIdentity[]> = listAgentAdapterIdentities,
): Promise<void> {
  request ??= list().then(
    (identities) => setSnapshot({ identities, failed: false }),
    () => {
      request = null;
      setSnapshot({ identities: snapshot.identities, failed: true });
    },
  );
  return request;
}

export function useAgentAdapterDictionary(): AgentAdapterDictionary {
  const { identities, failed } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  useEffect(() => {
    if (!identities) void loadAgentAdapterIdentities();
  }, [identities]);
  return useMemo(
    () =>
      createAgentAdapterDictionary(identities ?? [], !!identities || failed),
    [failed, identities],
  );
}
