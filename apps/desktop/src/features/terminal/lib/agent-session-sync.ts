export interface InvalidationGuard {
  capture(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export interface LatestTaskQueue<T> {
  run(task: () => Promise<T>): Promise<T>;
}

export function createInvalidationGuard(): InvalidationGuard {
  let generation = 0;
  return {
    capture: () => generation,
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}

/**
 * Runs tasks one at a time. A task submitted while another runs waits for it;
 * newer submissions replace the waiting one, so only the latest input is
 * applied after the running task finishes.
 */
export function createLatestTaskQueue<T>(): LatestTaskQueue<T> {
  let running = false;
  let queued: {
    task: () => Promise<T>;
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  const start = (task: () => Promise<T>): Promise<T> => {
    running = true;
    const promise = Promise.resolve().then(task);
    const next = () => {
      running = false;
      const item = queued;
      queued = null;
      if (item) start(item.task).then(item.resolve, item.reject);
    };
    void promise.then(next, next);
    return promise;
  };

  return {
    run(task) {
      if (!running) return start(task);
      if (queued) {
        queued.task = task;
        return queued.promise;
      }
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      queued = { task, promise, resolve, reject };
      return promise;
    },
  };
}
