/** A view that shows the output of one PTY, such as an xterm instance. */
export interface TerminalOutputView {
  /** Shows output; `onProcessed` runs once the view has processed `data`. */
  write(data: string, onProcessed?: () => void): void;
}

export interface TerminalViewAttachment {
  /**
   * Whether input from this view may reach the PTY now: the view finished
   * restoring past output and is the last attached view of its PTY.
   */
  acceptsInput(): boolean;
  detach(): void;
}

interface AttachedView {
  view: TerminalOutputView;
  restoring: boolean;
}

interface TerminalReplayBuffer {
  chunks: string[];
  size: number;
}

const MAX_REPLAY_CHARS = 2_000_000;

const replayBuffers = new Map<string, TerminalReplayBuffer>();
// Insertion order is attach order: the last view owns the PTY input.
const attachedViews = new Map<string, Set<AttachedView>>();
const discardedPtyIds = new Set<string>();

export function publishTerminalOutput(ptyId: string, data: string): void {
  if (discardedPtyIds.has(ptyId)) return;

  appendReplayOutput(ptyId, data);

  attachedViews.get(ptyId)?.forEach((attached) => attached.view.write(data));
}

/**
 * Shows the PTY output in a view: replays past output, then live output.
 * Answers the view gives to replayed requests of the program must not reach
 * the PTY, so the view accepts input only after the replay is processed.
 */
export function attachTerminalView(
  ptyId: string,
  view: TerminalOutputView,
): TerminalViewAttachment {
  if (discardedPtyIds.has(ptyId)) {
    return { acceptsInput: () => false, detach: () => {} };
  }

  const attached: AttachedView = { view, restoring: false };
  const ptyViews = attachedViews.get(ptyId) ?? new Set<AttachedView>();
  ptyViews.add(attached);
  attachedViews.set(ptyId, ptyViews);

  replayTerminalOutput(ptyId, attached);

  return {
    acceptsInput: () =>
      !attached.restoring && lastAttachedView(ptyId) === attached,
    detach: () => {
      const current = attachedViews.get(ptyId);
      if (!current) return;
      current.delete(attached);
      if (current.size === 0) {
        attachedViews.delete(ptyId);
      }
    },
  };
}

export function clearTerminalOutput(ptyId: string): void {
  replayBuffers.delete(ptyId);
  attachedViews.delete(ptyId);
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

function replayTerminalOutput(ptyId: string, attached: AttachedView): void {
  const chunks = replayBuffers.get(ptyId)?.chunks ?? [];
  if (chunks.length === 0) return;

  attached.restoring = true;
  const lastIndex = chunks.length - 1;
  chunks.forEach((data, index) => {
    attached.view.write(
      data,
      index === lastIndex
        ? () => {
            attached.restoring = false;
          }
        : undefined,
    );
  });
}

function lastAttachedView(ptyId: string): AttachedView | undefined {
  let last: AttachedView | undefined;
  attachedViews.get(ptyId)?.forEach((attached) => {
    last = attached;
  });
  return last;
}
