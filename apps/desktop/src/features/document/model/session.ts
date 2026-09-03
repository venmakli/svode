import { DEFAULT_DOCUMENT_VIEW_STATE, type DocumentViewState } from "./types";

type SessionDisposer = () => void | Promise<void>;

export class DocumentRuntimeSession {
  readonly controller = new AbortController();
  private disposers: SessionDisposer[] = [];
  private destroyPromise: Promise<void> | null = null;
  private passwordHandler: ((password: string) => void) | null = null;
  private viewState: DocumentViewState = { ...DEFAULT_DOCUMENT_VIEW_STATE };

  constructor(
    readonly id: number,
    readonly targetKey: string,
  ) {}

  get signal() {
    return this.controller.signal;
  }

  addDisposer(disposer: SessionDisposer) {
    if (this.signal.aborted) {
      void disposer();
      return;
    }
    this.disposers.push(disposer);
  }

  setPasswordHandler(handler: ((password: string) => void) | null) {
    this.passwordHandler = handler;
  }

  submitPassword(password: string) {
    this.passwordHandler?.(password);
  }

  getViewState() {
    return { ...this.viewState };
  }

  setViewState(viewState: DocumentViewState) {
    this.viewState = { ...viewState };
  }

  async destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.controller.abort();
    this.passwordHandler = null;
    const disposers = this.disposers.splice(0).reverse();
    this.destroyPromise = (async () => {
      for (const disposer of disposers) await disposer();
    })();
    return this.destroyPromise;
  }
}

export class DocumentSessionCoordinator {
  private activationMarker = 0;
  private active: DocumentRuntimeSession | null = null;
  private handoffState = new Map<string, DocumentViewState>();

  async activate(session: DocumentRuntimeSession) {
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

  async handoff(session: DocumentRuntimeSession) {
    if (this.active !== session) return;
    this.activationMarker += 1;
    this.handoffState.set(session.targetKey, session.getViewState());
    this.active = null;
    await session.destroy();
  }

  async release(session: DocumentRuntimeSession) {
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

export const documentSessionCoordinator = new DocumentSessionCoordinator();
