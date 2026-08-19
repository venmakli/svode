export type RefreshRequest = "initial" | "refresh";

export interface RefreshScheduler {
  schedule(task: () => void, delayMs: number): () => void;
}

interface SingleFlightRefreshCoordinatorOptions<Snapshot> {
  debounceMs: number;
  load(request: RefreshRequest): Promise<Snapshot>;
  onFailure(error: unknown): void;
  onSuccess(snapshot: Snapshot): void;
  scheduler?: RefreshScheduler;
}

const defaultScheduler: RefreshScheduler = {
  schedule(task, delayMs) {
    const timeoutId = globalThis.setTimeout(task, delayMs);
    return () => globalThis.clearTimeout(timeoutId);
  },
};

export class SingleFlightRefreshCoordinator<Snapshot> {
  private active = false;
  private cancelScheduled: (() => void) | null = null;
  private disposed = false;
  private pendingRequest: RefreshRequest | null = null;
  private revision = 0;
  private waiters: Array<{
    resolve(snapshot: Snapshot | null): void;
    revision: number;
  }> = [];

  constructor(
    private readonly options: SingleFlightRefreshCoordinatorOptions<Snapshot>,
  ) {}

  loadInitial() {
    return this.request("initial", false);
  }

  invalidate() {
    return this.request("refresh", true);
  }

  retry() {
    return this.request("refresh", false);
  }

  supersede() {
    if (this.disposed) return;
    this.revision += 1;
    this.pendingRequest = null;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.settleWaiters(this.revision, null);
  }

  dispose() {
    this.disposed = true;
    this.revision += 1;
    this.pendingRequest = null;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.settleWaiters(this.revision, null);
  }

  private request(request: RefreshRequest, debounce: boolean) {
    if (this.disposed) return Promise.resolve<Snapshot | null>(null);

    this.revision += 1;
    const revision = this.revision;
    this.pendingRequest = request;
    const result = new Promise<Snapshot | null>((resolve) => {
      this.waiters.push({ resolve, revision });
    });
    if (this.active) return result;

    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (debounce && this.options.debounceMs > 0) {
      const scheduler = this.options.scheduler ?? defaultScheduler;
      this.cancelScheduled = scheduler.schedule(() => {
        this.cancelScheduled = null;
        this.runPending();
      }, this.options.debounceMs);
      return result;
    }

    this.runPending();
    return result;
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
            this.settleWaiters(revision, snapshot);
          }
        },
        (error: unknown) => {
          if (!this.disposed && revision === this.revision) {
            this.options.onFailure(error);
            this.settleWaiters(revision, null);
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

  private settleWaiters(revision: number, snapshot: Snapshot | null) {
    const pending: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (waiter.revision <= revision) waiter.resolve(snapshot);
      else pending.push(waiter);
    }
    this.waiters = pending;
  }
}
