export type ActiveSurfaceDeactivationResult = "ready" | "blocked";

type ActiveSurfaceDeactivationHandler = () =>
  | ActiveSurfaceDeactivationResult
  | Promise<ActiveSurfaceDeactivationResult>;

class ActiveSurfaceDeactivationOwner {
  private registration = 0;
  private supplemental = new Set<ActiveSurfaceDeactivationHandler>();

  registerSupplemental(handler: ActiveSurfaceDeactivationHandler) {
    this.supplemental.add(handler);
    return () => {
      this.supplemental.delete(handler);
    };
  }
  private handler: ActiveSurfaceDeactivationHandler | null = null;
  private inFlight: Promise<ActiveSurfaceDeactivationResult> | null = null;
  private awaitingDecision = false;
  private decisionListeners = new Set<() => void>();

  register(handler: ActiveSurfaceDeactivationHandler) {
    const registration = ++this.registration;
    this.handler = handler;
    return () => {
      if (registration !== this.registration) return;
      this.handler = null;
      this.inFlight = null;
      this.awaitingDecision = false;
    };
  }

  /** A handler of the current flight now waits for the user, not for work. */
  markAwaitingDecision() {
    if (!this.inFlight || this.awaitingDecision) return;
    this.awaitingDecision = true;
    for (const listener of this.decisionListeners) listener();
  }

  isAwaitingDecision() {
    return this.awaitingDecision;
  }

  subscribeDecision(listener: () => void) {
    this.decisionListeners.add(listener);
    return () => {
      this.decisionListeners.delete(listener);
    };
  }

  prepare(): Promise<ActiveSurfaceDeactivationResult> | null {
    if (!this.handler && this.supplemental.size === 0) return null;
    if (this.inFlight) return this.inFlight;
    const handlers = [...this.supplemental].reverse();
    if (this.handler) handlers.push(this.handler);
    const promise = Promise.resolve()
      .then(async () => {
        for (const handler of handlers)
          if ((await handler()) !== "ready") return "blocked" as const;
        return "ready" as const;
      })
      .catch(() => "blocked" as const)
      .finally(() => {
        if (this.inFlight !== promise) return;
        this.inFlight = null;
        this.awaitingDecision = false;
      });
    this.inFlight = promise;
    return promise;
  }
}

const activeSurfaceDeactivationOwner = new ActiveSurfaceDeactivationOwner();

export function registerActiveContentDeactivation(
  handler: ActiveSurfaceDeactivationHandler,
) {
  return activeSurfaceDeactivationOwner.register(handler);
}

export function prepareActiveContentDeactivation() {
  return activeSurfaceDeactivationOwner.prepare();
}

/**
 * Called by a deactivation handler that asks the user before it resolves, so
 * the pending transition stops presenting itself as loading meanwhile.
 */
export function markActiveContentAwaitingDecision() {
  activeSurfaceDeactivationOwner.markAwaitingDecision();
}

export function isActiveContentAwaitingDecision() {
  return activeSurfaceDeactivationOwner.isAwaitingDecision();
}

export function subscribeActiveContentDecision(listener: () => void) {
  return activeSurfaceDeactivationOwner.subscribeDecision(listener);
}

export function registerSupplementalContentDeactivation(
  handler: ActiveSurfaceDeactivationHandler,
) {
  return activeSurfaceDeactivationOwner.registerSupplemental(handler);
}
