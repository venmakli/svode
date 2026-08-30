export type ActiveSurfaceDeactivationResult = "ready" | "blocked";

type ActiveSurfaceDeactivationHandler = () =>
  | ActiveSurfaceDeactivationResult
  | Promise<ActiveSurfaceDeactivationResult>;

class ActiveSurfaceDeactivationOwner {
  private registration = 0;
  private handler: ActiveSurfaceDeactivationHandler | null = null;
  private inFlight: Promise<ActiveSurfaceDeactivationResult> | null = null;

  register(handler: ActiveSurfaceDeactivationHandler) {
    const registration = ++this.registration;
    this.handler = handler;
    return () => {
      if (registration !== this.registration) return;
      this.handler = null;
      this.inFlight = null;
    };
  }

  prepare(): Promise<ActiveSurfaceDeactivationResult> | null {
    if (!this.handler) return null;
    if (this.inFlight) return this.inFlight;
    const handler = this.handler;
    const promise = Promise.resolve()
      .then(handler)
      .catch(() => "blocked" as const)
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null;
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
