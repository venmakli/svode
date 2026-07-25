export interface CompletionDrivenPollingOptions {
  intervalMs: number;
  task: () => Promise<void>;
  onError?: (error: unknown) => void;
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (timeoutId: number) => void;
}

export interface InvalidationGuard {
  capture(): number;
  invalidate(): void;
  isCurrent(token: number): boolean;
}

export interface KeyedSingleFlight<T> {
  run(key: string, task: () => Promise<T>): Promise<T>;
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

export function createKeyedSingleFlight<T>(): KeyedSingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, task: () => Promise<T>): Promise<T> {
      const current = inFlight.get(key);
      if (current) {
        return current;
      }

      const promise = Promise.resolve().then(task);
      inFlight.set(key, promise);
      const clear = () => {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key);
        }
      };
      void promise.then(clear, clear);
      return promise;
    },
  };
}

export function startCompletionDrivenPolling({
  intervalMs,
  task,
  onError,
  setTimeout = window.setTimeout.bind(window),
  clearTimeout = window.clearTimeout.bind(window),
}: CompletionDrivenPollingOptions): () => void {
  let stopped = false;
  let timeoutId: number | null = null;

  const run = async () => {
    try {
      await task();
    } catch (error) {
      onError?.(error);
    } finally {
      if (!stopped) {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          void run();
        }, intervalMs);
      }
    }
  };

  void run();

  return () => {
    stopped = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}
