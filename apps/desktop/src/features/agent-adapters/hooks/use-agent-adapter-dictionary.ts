import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  listAgentAdapterIdentities,
  listenCustomAgentsChanged,
} from "../api/agent-adapters";
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
let followingChanges = false;
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

// Custom agents carry their own labels: any window that adds, renames or
// removes one makes every window read the labels again.
function followCustomAgentChanges() {
  if (followingChanges) return;
  followingChanges = true;
  listenCustomAgentsChanged(() => {
    request = null;
    void loadAgentAdapterIdentities();
  }).catch(() => {
    followingChanges = false;
  });
}

/**
 * Reads the agent labels once for the app process, and again when custom
 * agents change; every agent label shares the result. A failed read is
 * retried by the next call.
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
    followCustomAgentChanges();
    if (!identities) void loadAgentAdapterIdentities();
  }, [identities]);
  return useMemo(
    () =>
      createAgentAdapterDictionary(identities ?? [], !!identities || failed),
    [failed, identities],
  );
}
