import {
  activateRepositoryAccessLifecycle,
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
  activate(spacePath: string): Promise<RepositoryAccessSnapshot>;
  load(spacePath: string): Promise<RepositoryAccessSnapshot>;
  verify(spacePath: string): Promise<RepositoryAccessSnapshot>;
  listen(handler: (repositoryId: string) => void): Promise<() => void>;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export class RepositoryAccessOwner {
  private readonly activePaths = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
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
  private readonly activationFlights = new Map<
    string,
    Promise<RepositoryAccessSnapshot | null>
  >();
  private readonly invalidatedReads = new Set<string>();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private listening = false;
  private listenReady: Promise<void> = Promise.resolve();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly api: RepositoryAccessOwnerApi,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  getSnapshot = (spacePath: string): RepositoryAccessView => {
    return this.ensurePathState(spacePath);
  };

  retain(spacePath: string, options: { refresh?: boolean } = {}): () => void {
    this.startListening();
    if (options.refresh !== false) void this.refresh(spacePath);
    return () => undefined;
  }

  retainActive(spacePath: string): () => void {
    if (!spacePath) return () => undefined;
    this.startListening();
    this.activePaths.set(spacePath, (this.activePaths.get(spacePath) ?? 0) + 1);
    void this.activate(spacePath);
    return () => {
      const count = this.activePaths.get(spacePath) ?? 0;
      if (count <= 1) this.activePaths.delete(spacePath);
      else this.activePaths.set(spacePath, count - 1);
    };
  }

  async activate(spacePath: string): Promise<RepositoryAccessSnapshot | null> {
    if (!this.activePaths.has(spacePath)) return null;
    await this.startListening();
    // Attach the repository before checking events arrive, and cancel a pending
    // activation if its host disappears while the local read is in flight.
    await this.refresh(spacePath);
    if (!this.activePaths.has(spacePath)) return null;
    return this.runVerification(spacePath, true);
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

    const readState = this.ensurePathState(spacePath);
    const isCurrentRead = () => {
      const latest = this.ensurePathState(spacePath);
      return (
        latest.snapshot === readState.snapshot &&
        latest.verifying === readState.verifying &&
        latest.error === readState.error
      );
    };
    const promise = this.api.load(spacePath).then(
      (snapshot) => {
        if (isCurrentRead())
          this.publish(spacePath, snapshot, { clearError: true });
        return this.ensurePathState(spacePath).snapshot;
      },
      (error: unknown) => {
        if (isCurrentRead())
          this.updateRepositoryState(spacePath, (state) => ({
            ...state,
            error: errorMessage(error),
            loading: false,
          }));
        return null;
      },
    );
    this.readFlights.set(key, promise);
    void promise.finally(() => {
      if (this.readFlights.get(key) === promise) this.readFlights.delete(key);
      if (this.invalidatedReads.delete(key)) void this.refresh(spacePath);
    });
    return promise;
  }

  verify(spacePath: string): Promise<RepositoryAccessSnapshot | null> {
    return this.runVerification(spacePath, false);
  }

  private runVerification(
    spacePath: string,
    automatic: boolean,
  ): Promise<RepositoryAccessSnapshot | null> {
    if (!spacePath) return Promise.resolve(null);
    const repositoryId = this.pathRepositoryIds.get(spacePath);
    const key = repositoryId
      ? `repository:${repositoryId}`
      : `path:${spacePath}`;
    const flights = automatic ? this.activationFlights : this.verifyFlights;
    const existing = flights.get(key);
    if (existing) return existing;

    const initialSnapshot = this.ensurePathState(spacePath).snapshot;
    if (!automatic)
      this.updateRepositoryState(spacePath, (state) => ({
        ...state,
        error: null,
        loading: false,
        verifying: true,
      }));
    // Automatic requests can be no-ops. Only canonical checking marks them busy.
    const request = automatic
      ? this.api.activate(spacePath)
      : this.api.verify(spacePath);
    const promise = request.then(
      (snapshot) => {
        this.publish(spacePath, snapshot, {
          clearError: true,
          verifying: automatic ? undefined : false,
        });
        return this.repositorySnapshots.get(snapshot.repositoryId) ?? snapshot;
      },
      (error: unknown) => {
        this.updateRepositoryState(spacePath, (state) => ({
          ...state,
          error:
            state.snapshot &&
            state.snapshot.generation > (initialSnapshot?.generation ?? 0) &&
            (state.snapshot.status === "writable" ||
              state.snapshot.status === "local")
              ? null
              : errorMessage(error),
          loading: false,
          verifying: automatic ? state.verifying : false,
        }));
        return null;
      },
    );
    flights.set(key, promise);
    void promise.finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    });
    return promise;
  }

  handleInvalidation(repositoryId: string): void {
    const paths = this.repositoryPaths.get(repositoryId);
    const path = paths?.values().next().value;
    if (!path) return;
    const key = `repository:${repositoryId}`;
    if (this.readFlights.has(key)) this.invalidatedReads.add(key);
    else void this.refresh(path);
  }

  dispose(): void {
    if (this.unlisten) this.unlisten();
    this.unlisten = null;
    this.listening = false;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.activePaths.clear();
  }

  private startListening(): Promise<void> {
    if (this.listening) return this.listenReady;
    this.listening = true;
    this.listenReady = this.api
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
    return this.listenReady;
  }

  private publish(
    spacePath: string,
    snapshot: RepositoryAccessSnapshot,
    options: { clearError: boolean; verifying?: boolean },
  ): void {
    const current = this.repositorySnapshots.get(snapshot.repositoryId);
    if (current && current.generation > snapshot.generation) {
      this.attachPath(spacePath, current.repositoryId);
      this.applySnapshotToPaths(current, {
        clearError: false,
        verifying: options.verifying,
      });
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
    options: { clearError: boolean; verifying?: boolean },
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
        verifying: options.verifying ?? current.verifying,
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
        const paths = this.repositoryPaths.get(snapshot.repositoryId);
        const activePath =
          paths && [...paths].find((path) => this.activePaths.has(path));
        if (activePath) void this.activate(activePath);
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.expiryTimers.set(snapshot.repositoryId, timer);
  }

  private emit(): void {
    this.version += 1;
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
  activate: activateRepositoryAccessLifecycle,
  listen: listenToRepositoryAccessChanges,
  load: loadRepositoryAccess,
  verify: checkRepositoryAccess,
});
