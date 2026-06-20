type TerminalOutputHandler = (data: string) => void;

const buffers = new Map<string, string[]>();
const listeners = new Map<string, Set<TerminalOutputHandler>>();
const discardedPtyIds = new Set<string>();

export function publishTerminalOutput(ptyId: string, data: string): void {
  if (discardedPtyIds.has(ptyId)) return;

  const ptyListeners = listeners.get(ptyId);
  if (!ptyListeners || ptyListeners.size === 0) {
    const pending = buffers.get(ptyId) ?? [];
    pending.push(data);
    buffers.set(ptyId, pending);
    return;
  }

  ptyListeners.forEach((listener) => listener(data));
}

export function subscribeTerminalOutput(
  ptyId: string,
  handler: TerminalOutputHandler,
): () => void {
  if (discardedPtyIds.has(ptyId)) return () => {};

  const ptyListeners = listeners.get(ptyId) ?? new Set<TerminalOutputHandler>();
  ptyListeners.add(handler);
  listeners.set(ptyId, ptyListeners);

  const pending = buffers.get(ptyId);
  if (pending) {
    pending.forEach((data) => handler(data));
    buffers.delete(ptyId);
  }

  return () => {
    const current = listeners.get(ptyId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      listeners.delete(ptyId);
    }
  };
}

export function clearTerminalOutput(ptyId: string): void {
  buffers.delete(ptyId);
  listeners.delete(ptyId);
  discardedPtyIds.add(ptyId);
}
