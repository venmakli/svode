export type AgentContextRefreshRequest = "initial" | "refresh";

export interface AgentContextRefreshScheduler {
  schedule(task: () => void, delayMs: number): () => void;
}

interface AgentContextRefreshCoordinatorOptions<Snapshot> {
  debounceMs: number;
  load(request: AgentContextRefreshRequest): Promise<Snapshot>;
  onFailure(error: unknown): void;
  onSuccess(snapshot: Snapshot): void;
  scheduler?: AgentContextRefreshScheduler;
}

const defaultScheduler: AgentContextRefreshScheduler = {
  schedule(task, delayMs) {
    const timeoutId = globalThis.setTimeout(task, delayMs);
    return () => globalThis.clearTimeout(timeoutId);
  },
};

export class AgentContextRefreshCoordinator<Snapshot> {
  private active = false;
  private cancelScheduled: (() => void) | null = null;
  private disposed = false;
  private pendingRequest: AgentContextRefreshRequest | null = null;
  private revision = 0;

  constructor(
    private readonly options: AgentContextRefreshCoordinatorOptions<Snapshot>,
  ) {}

  loadInitial() {
    this.request("initial", false);
  }

  invalidate() {
    this.request("refresh", true);
  }

  retry() {
    this.request("refresh", false);
  }

  dispose() {
    this.disposed = true;
    this.revision += 1;
    this.pendingRequest = null;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }

  private request(request: AgentContextRefreshRequest, debounce: boolean) {
    if (this.disposed) return;

    this.revision += 1;
    this.pendingRequest = request;
    if (this.active) return;

    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (debounce && this.options.debounceMs > 0) {
      const scheduler = this.options.scheduler ?? defaultScheduler;
      this.cancelScheduled = scheduler.schedule(() => {
        this.cancelScheduled = null;
        this.runPending();
      }, this.options.debounceMs);
      return;
    }

    this.runPending();
  }

  private runPending() {
    if (this.disposed || this.active || this.pendingRequest === null) return;

    this.cancelScheduled?.();
    this.cancelScheduled = null;
    const request = this.pendingRequest;
    const revision = this.revision;
    this.pendingRequest = null;
    this.active = true;

    void Promise.resolve()
      .then(() => this.options.load(request))
      .then(
        (snapshot) => {
          if (!this.disposed && revision === this.revision) {
            this.options.onSuccess(snapshot);
          }
        },
        (error: unknown) => {
          if (!this.disposed && revision === this.revision) {
            this.options.onFailure(error);
          }
        },
      )
      .finally(() => {
        this.active = false;
        if (!this.disposed && this.pendingRequest !== null) {
          this.runPending();
        }
      });
  }
}
