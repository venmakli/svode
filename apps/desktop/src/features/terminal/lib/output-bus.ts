type TerminalOutputHandler = (data: string) => void;

interface TerminalReplayBuffer {
  chunks: string[];
  size: number;
}

const MAX_REPLAY_CHARS = 2_000_000;

const replayBuffers = new Map<string, TerminalReplayBuffer>();
const listeners = new Map<string, Set<TerminalOutputHandler>>();
const discardedPtyIds = new Set<string>();

export function publishTerminalOutput(ptyId: string, data: string): void {
  if (discardedPtyIds.has(ptyId)) return;

  appendReplayOutput(ptyId, data);

  const ptyListeners = listeners.get(ptyId);
  if (!ptyListeners || ptyListeners.size === 0) return;

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

  replayTerminalOutput(ptyId, handler);

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
  replayBuffers.delete(ptyId);
  listeners.delete(ptyId);
  discardedPtyIds.add(ptyId);
}

function appendReplayOutput(ptyId: string, data: string): void {
  const replay = replayBuffers.get(ptyId) ?? { chunks: [], size: 0 };
  replay.chunks.push(data);
  replay.size += data.length;

  while (replay.size > MAX_REPLAY_CHARS && replay.chunks.length > 1) {
    const removed = replay.chunks.shift();
    replay.size -= removed?.length ?? 0;
  }

  replayBuffers.set(ptyId, replay);
}

function replayTerminalOutput(
  ptyId: string,
  handler: TerminalOutputHandler,
): void {
  const replay = replayBuffers.get(ptyId);
  replay?.chunks.forEach((data) => handler(data));
}
