import { useEffect, useState } from "react";
import { getDefaultAgent, setDefaultAgent } from "../api/chat";
import type { DefaultAgent } from "../model/agents";

export interface DefaultAgentState {
  /** The device's default agent; null while none is chosen. */
  value: DefaultAgent | null;
  /** It was read, or reading failed and counts as none. */
  loaded: boolean;
}

const listeners = new Set<(value: DefaultAgent | null) => void>();
/** The value this window read or chose last. */
let known: DefaultAgent | null = null;
/** Counts choices, so a read that began before one does not undo it. */
let revision = 0;
let writes: Promise<unknown> = Promise.resolve();

function publish(value: DefaultAgent | null) {
  known = value;
  for (const listener of listeners) listener(value);
}

/**
 * The default agent of this device (Stage 11 `03`): read anew by every
 * surface that shows it, as a new session draft once it opens, and
 * followed while a surface of this window chooses it.
 */
export function useDefaultAgent(): DefaultAgentState {
  const [state, setState] = useState<DefaultAgentState>({
    value: null,
    loaded: false,
  });
  useEffect(() => {
    let current = true;
    const listener = (value: DefaultAgent | null) =>
      setState({ value, loaded: true });
    listeners.add(listener);
    const started = revision;
    getDefaultAgent().then(
      (value) => {
        if (!current) return;
        if (started !== revision) return setState({ value: known, loaded: true });
        known = value ?? null;
        setState({ value: known, loaded: true });
      },
      (error: unknown) => {
        console.error("Failed to read the default agent:", error);
        if (current) setState({ value: known, loaded: true });
      },
    );
    return () => {
      current = false;
      listeners.delete(listener);
    };
  }, []);
  return state;
}

/** The default agent this window read or chose last. */
export function knownDefaultAgent(): DefaultAgent | null {
  return known;
}

/**
 * Chooses the device's default agent at once: surfaces of this window show
 * it before it is stored, and a failed write brings back the stored value
 * and rejects. Choices are stored in the order they were made.
 */
export function chooseDefaultAgent(next: DefaultAgent | null): Promise<void> {
  revision += 1;
  publish(next);
  const write = writes.then(() => setDefaultAgent(next));
  writes = write.catch(() => {});
  return write.catch(async (error: unknown) => {
    const stored = await getDefaultAgent().catch(() => known);
    revision += 1;
    publish(stored ?? null);
    throw error;
  });
}
