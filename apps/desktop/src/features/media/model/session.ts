import { DEFAULT_MEDIA_VIEW_STATE, type MediaViewState } from "./types";

type SessionDisposer = () => void | Promise<void>;
type SessionSuspender = () => void | Promise<void>;

export class MediaRuntimeSession {
  readonly controller = new AbortController();
  private disposers: SessionDisposer[] = [];
  private suspenders: SessionSuspender[] = [];
  private destroyPromise: Promise<void> | null = null;
  private loadTimeout: ReturnType<typeof setTimeout> | null = null;
  private viewState: MediaViewState;

  constructor(
    readonly id: number,
    readonly targetKey: string,
    initialViewState: MediaViewState = DEFAULT_MEDIA_VIEW_STATE,
  ) {
    this.viewState = cloneViewState(initialViewState);
  }

  get signal() {
    return this.controller.signal;
  }

  addDisposer(disposer: SessionDisposer) {
    if (this.signal.aborted) {
      void disposer();
      return () => undefined;
    }
    this.disposers.push(disposer);
    return () => {
      const index = this.disposers.indexOf(disposer);
      if (index >= 0) this.disposers.splice(index, 1);
    };
  }

  addExternalSuspender(suspender: SessionSuspender) {
    if (this.signal.aborted) return () => undefined;
    this.suspenders.push(suspender);
    return () => {
      const index = this.suspenders.indexOf(suspender);
      if (index >= 0) this.suspenders.splice(index, 1);
    };
  }

  async suspendForExternalOpen() {
    for (const suspender of [...this.suspenders].reverse()) await suspender();
  }

  setLoadTimeout(callback: () => void, durationMs: number) {
    this.clearLoadTimeout();
    this.loadTimeout = setTimeout(callback, durationMs);
  }

  clearLoadTimeout() {
    if (this.loadTimeout !== null) clearTimeout(this.loadTimeout);
    this.loadTimeout = null;
  }

  getViewState() {
    return cloneViewState(this.viewState);
  }

  setViewState(viewState: MediaViewState) {
    this.viewState = cloneViewState(viewState);
  }

  async destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.controller.abort();
    this.clearLoadTimeout();
    this.suspenders = [];
    const disposers = this.disposers.splice(0).reverse();
    this.destroyPromise = (async () => {
      for (const disposer of disposers) {
        try {
          await disposer();
        } catch {
          // Cleanup is best-effort per resource; later disposers still run.
        }
      }
    })();
    return this.destroyPromise;
  }
}

export class MediaSessionCoordinator {
  private activationMarker = 0;
  private active: MediaRuntimeSession | null = null;
  private handoffState = new Map<string, MediaViewState>();

  async activate(session: MediaRuntimeSession) {
    const marker = ++this.activationMarker;
    const previous = this.active;
    if (previous && previous !== session) await previous.destroy();
    if (marker !== this.activationMarker) {
      await session.destroy();
      return false;
    }
    const handoff = this.handoffState.get(session.targetKey);
    if (handoff) {
      session.setViewState(handoff);
      this.handoffState.delete(session.targetKey);
    }
    this.active = session;
    return true;
  }

  async handoff(session: MediaRuntimeSession) {
    if (this.active !== session) return;
    this.activationMarker += 1;
    this.handoffState.set(session.targetKey, session.getViewState());
    this.active = null;
    await session.destroy();
  }

  async release(session: MediaRuntimeSession) {
    if (this.active === session) {
      this.activationMarker += 1;
      this.active = null;
    }
    await session.destroy();
  }

  resetForTests() {
    this.activationMarker += 1;
    this.active = null;
    this.handoffState.clear();
  }
}

export const mediaSessionCoordinator = new MediaSessionCoordinator();

function cloneViewState(viewState: MediaViewState): MediaViewState {
  return {
    ...viewState,
    playback: { ...viewState.playback },
  };
}
