import {
  checkRepositoryAccess,
  listenToRepositoryAccessChanges,
  loadRepositoryAccess,
} from "../api/repository-access-api";
import type { RepositoryAccessSnapshot } from "./repository-access";

export interface RepositoryAccessView {
  error: string | null;
  loading: boolean;
  snapshot: RepositoryAccessSnapshot | null;
  spacePath: string;
  verifying: boolean;
}

interface RepositoryAccessOwnerApi {
  load(spacePath: string): Promise<RepositoryAccessSnapshot>;
  verify(spacePath: string): Promise<RepositoryAccessSnapshot>;
  listen(handler: (repositoryId: string) => void): Promise<() => void>;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export class RepositoryAccessOwner {
  private readonly listeners = new Set<() => void>();
  private readonly pathStates = new Map<string, RepositoryAccessView>();
  private readonly pathRepositoryIds = new Map<string, string>();
  private readonly repositoryPaths = new Map<string, Set<string>>();
  private readonly repositorySnapshots = new Map<
    string,
    RepositoryAccessSnapshot
  >();
  private readonly readFlights = new Map<
    string,
    Promise<RepositoryAccessSnapshot | null>
  >();
  private readonly verifyFlights = new Map<
    string,
    Promise<RepositoryAccessSnapshot | null>
  >();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private listening = false;
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly api: RepositoryAccessOwnerApi,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (spacePath: string): RepositoryAccessView => {
    return this.ensurePathState(spacePath);
  };

  retain(spacePath: string): () => void {
    this.startListening();
    void this.refresh(spacePath);
    return () => undefined;
  }

  refresh(spacePath: string): Promise<RepositoryAccessSnapshot | null> {
    if (!spacePath) return Promise.resolve(null);
    const repositoryId = this.pathRepositoryIds.get(spacePath);
    const key = repositoryId
      ? `repository:${repositoryId}`
      : `path:${spacePath}`;
    const existing = this.readFlights.get(key);
    if (existing) return existing;

    const current = this.ensurePathState(spacePath);
    if (!current.snapshot) {
      this.setPathState(spacePath, { ...current, loading: true, error: null });
    }

    const promise = this.api.load(spacePath).then(
      (snapshot) => {
        this.publish(spacePath, snapshot, { clearError: true });
        return this.repositorySnapshots.get(snapshot.repositoryId) ?? snapshot;
      },
      (error: unknown) => {
        this.setPathState(spacePath, {
          ...this.ensurePathState(spacePath),
          error: errorMessage(error),
          loading: false,
        });
        return null;
      },
    );
    this.readFlights.set(key, promise);
    void promise.finally(() => {
      if (this.readFlights.get(key) === promise) this.readFlights.delete(key);
    });
    return promise;
  }

  verify(spacePath: string): Promise<RepositoryAccessSnapshot | null> {
    if (!spacePath) return Promise.resolve(null);
    const repositoryId = this.pathRepositoryIds.get(spacePath);
    const key = repositoryId
      ? `repository:${repositoryId}`
      : `path:${spacePath}`;
    const existing = this.verifyFlights.get(key);
    if (existing) return existing;

    this.updateRepositoryState(spacePath, (state) => ({
      ...state,
      error: null,
      loading: false,
      verifying: true,
    }));
    const promise = this.api.verify(spacePath).then(
      (snapshot) => {
        this.publish(spacePath, snapshot, { clearError: true });
        return this.repositorySnapshots.get(snapshot.repositoryId) ?? snapshot;
      },
      (error: unknown) => {
        this.updateRepositoryState(spacePath, (state) => ({
          ...state,
          error: errorMessage(error),
          loading: false,
          verifying: false,
        }));
        return null;
      },
    );
    this.verifyFlights.set(key, promise);
    void promise.finally(() => {
      if (this.verifyFlights.get(key) === promise)
        this.verifyFlights.delete(key);
    });
    return promise;
  }

  handleInvalidation(repositoryId: string): void {
    const paths = this.repositoryPaths.get(repositoryId);
    const path = paths?.values().next().value;
    if (path) void this.refresh(path);
  }

  dispose(): void {
    if (this.unlisten) this.unlisten();
    this.unlisten = null;
    this.listening = false;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    void this.api
      .listen((repositoryId) => this.handleInvalidation(repositoryId))
      .then((unlisten) => {
        if (!this.listening) {
          unlisten();
          return;
        }
        this.unlisten = unlisten;
      })
      .catch((error) => {
        this.listening = false;
        console.error(
          "Failed to subscribe to repository access changes:",
          error,
        );
      });
  }

  private publish(
    spacePath: string,
    snapshot: RepositoryAccessSnapshot,
    options: { clearError: boolean },
  ): void {
    const current = this.repositorySnapshots.get(snapshot.repositoryId);
    if (current && current.generation > snapshot.generation) {
      this.attachPath(spacePath, current.repositoryId);
      this.applySnapshotToPaths(current, options);
      return;
    }

    if (current && sameSnapshot(current, snapshot)) {
      this.attachPath(spacePath, current.repositoryId);
      this.applySnapshotToPaths(current, options);
      return;
    }

    this.repositorySnapshots.set(snapshot.repositoryId, snapshot);
    this.attachPath(spacePath, snapshot.repositoryId);
    this.applySnapshotToPaths(snapshot, options);
    this.scheduleExpiry(snapshot);
  }

  private attachPath(spacePath: string, repositoryId: string): void {
    const previousRepositoryId = this.pathRepositoryIds.get(spacePath);
    if (previousRepositoryId && previousRepositoryId !== repositoryId) {
      this.repositoryPaths.get(previousRepositoryId)?.delete(spacePath);
    }
    this.pathRepositoryIds.set(spacePath, repositoryId);
    const paths = this.repositoryPaths.get(repositoryId) ?? new Set<string>();
    paths.add(spacePath);
    this.repositoryPaths.set(repositoryId, paths);
  }

  private applySnapshotToPaths(
    snapshot: RepositoryAccessSnapshot,
    options: { clearError: boolean },
  ): void {
    const paths = this.repositoryPaths.get(snapshot.repositoryId);
    if (!paths) return;
    let changed = false;
    for (const path of paths) {
      const current = this.ensurePathState(path);
      const next: RepositoryAccessView = Object.freeze({
        error: options.clearError ? null : current.error,
        loading: false,
        snapshot,
        spacePath: path,
        verifying: false,
      });
      if (!sameView(current, next)) {
        this.pathStates.set(path, next);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private updateRepositoryState(
    spacePath: string,
    update: (state: RepositoryAccessView) => RepositoryAccessView,
  ): void {
    const repositoryId = this.pathRepositoryIds.get(spacePath);
    const paths = repositoryId
      ? this.repositoryPaths.get(repositoryId)
      : new Set([spacePath]);
    if (!paths) return;
    let changed = false;
    for (const path of paths) {
      const current = this.ensurePathState(path);
      const next = Object.freeze({ ...update(current), spacePath: path });
      if (!sameView(current, next)) {
        this.pathStates.set(path, next);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private setPathState(spacePath: string, next: RepositoryAccessView): void {
    const current = this.ensurePathState(spacePath);
    if (sameView(current, next)) return;
    this.pathStates.set(spacePath, Object.freeze(next));
    this.emit();
  }

  private ensurePathState(spacePath: string): RepositoryAccessView {
    const existing = this.pathStates.get(spacePath);
    if (existing) return existing;
    const initial = Object.freeze({
      error: null,
      loading: false,
      snapshot: null,
      spacePath,
      verifying: false,
    });
    this.pathStates.set(spacePath, initial);
    return initial;
  }

  private scheduleExpiry(snapshot: RepositoryAccessSnapshot): void {
    const currentTimer = this.expiryTimers.get(snapshot.repositoryId);
    if (currentTimer) clearTimeout(currentTimer);
    this.expiryTimers.delete(snapshot.repositoryId);
    if (!snapshot.expiresAt) return;
    if (snapshot.status !== "writable" && snapshot.status !== "read_only") {
      return;
    }
    const expiresAtMs = snapshot.expiresAt * 1_000;
    if (expiresAtMs <= this.now()) return;
    const delay = expiresAtMs - this.now() + 25;
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(snapshot.repositoryId);
        this.handleInvalidation(snapshot.repositoryId);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.expiryTimers.set(snapshot.repositoryId, timer);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameView(left: RepositoryAccessView, right: RepositoryAccessView) {
  return (
    left.error === right.error &&
    left.loading === right.loading &&
    left.snapshot === right.snapshot &&
    left.spacePath === right.spacePath &&
    left.verifying === right.verifying
  );
}

function sameSnapshot(
  left: RepositoryAccessSnapshot,
  right: RepositoryAccessSnapshot,
) {
  return (
    left.repositoryId === right.repositoryId &&
    left.generation === right.generation &&
    left.status === right.status &&
    left.reason === right.reason &&
    left.checkedAt === right.checkedAt &&
    left.expiresAt === right.expiresAt &&
    left.lastKnownStatus === right.lastKnownStatus
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown repository access error";
}

export const repositoryAccessOwner = new RepositoryAccessOwner({
  listen: listenToRepositoryAccessChanges,
  load: loadRepositoryAccess,
  verify: checkRepositoryAccess,
});
