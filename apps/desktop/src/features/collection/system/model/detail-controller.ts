import type {
  SystemCollectionDetailController,
  SystemCollectionDetailFocusOptions,
  SystemCollectionDetailRequest,
  SystemCollectionDetailSelection,
} from "./types";

export interface SystemCollectionDetailActiveState {
  focus: SystemCollectionDetailFocusOptions;
  request: SystemCollectionDetailRequest;
}

export interface SystemCollectionDetailControllerSnapshot {
  active: SystemCollectionDetailActiveState | null;
  diagnostic: string | null;
  displayed: SystemCollectionDetailActiveState | null;
  pending: boolean;
}

export interface SystemCollectionDetailControllerStore {
  controller: SystemCollectionDetailController;
  focusAfterClose(): boolean;
  getSnapshot(): SystemCollectionDetailControllerSnapshot;
  subscribe(listener: () => void): () => void;
}

interface CreateSystemCollectionDetailControllerStoreInput {
  guardErrorMessage: string;
}

const initialSnapshot: SystemCollectionDetailControllerSnapshot = {
  active: null,
  diagnostic: null,
  displayed: null,
  pending: false,
};

export function createSystemCollectionDetailControllerStore({
  guardErrorMessage,
}: CreateSystemCollectionDetailControllerStoreInput): SystemCollectionDetailControllerStore {
  let snapshot = initialSnapshot;
  let restoreFocus: SystemCollectionDetailFocusOptions = {};
  let transitionTail: Promise<void> = Promise.resolve();
  let queuedTransitions = 0;
  const listeners = new Set<() => void>();

  function publish(
    patch: Partial<SystemCollectionDetailControllerSnapshot>,
  ): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  }

  function setQueuedTransitionCount(nextCount: number): void {
    queuedTransitions = nextCount;
    const pending = queuedTransitions > 0;
    if (snapshot.pending !== pending) {
      publish({ pending });
    }
  }

  function enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    setQueuedTransitionCount(queuedTransitions + 1);
    const result = transitionTail.then(operation, operation);
    transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      setQueuedTransitionCount(Math.max(0, queuedTransitions - 1));
    });
  }

  async function canLeaveActiveDetail(): Promise<boolean> {
    const current = snapshot.active;
    if (!current?.request.canClose) {
      return true;
    }

    try {
      return (await current.request.canClose()) === true;
    } catch (error) {
      publish({
        diagnostic:
          error instanceof Error && error.message
            ? error.message
            : guardErrorMessage,
      });
      return false;
    }
  }

  function captureFocus(
    options?: SystemCollectionDetailFocusOptions,
  ): SystemCollectionDetailFocusOptions {
    if (options?.returnFocus) {
      return options;
    }

    const activeElement =
      typeof document === "undefined" ? null : document.activeElement;
    const captured =
      activeElement &&
      typeof (activeElement as HTMLElement).focus === "function"
        ? (activeElement as HTMLElement)
        : null;

    return captured
      ? {
          ...options,
          returnFocus: () => captured,
        }
      : (options ?? {});
  }

  const controller: SystemCollectionDetailController = {
    open(request, focusOptions) {
      return enqueue(async () => {
        const current = snapshot.active;
        if (
          current &&
          systemCollectionDetailSelectionEquals(
            current.request.selection,
            request.selection,
          )
        ) {
          const active = {
            focus:
              focusOptions === undefined
                ? current.focus
                : captureFocus(focusOptions),
            request,
          };
          publish({
            active,
            diagnostic: null,
            displayed: active,
          });
          return true;
        }

        if (current && !(await canLeaveActiveDetail())) {
          return false;
        }

        restoreFocus = {};
        const active = {
          focus: captureFocus(focusOptions),
          request,
        };
        publish({
          active,
          diagnostic: null,
          displayed: active,
        });
        return true;
      });
    },

    close(selection) {
      return enqueue(async () => {
        const current = snapshot.active;
        if (
          !current ||
          (selection &&
            !systemCollectionDetailSelectionEquals(
              current.request.selection,
              selection,
            ))
        ) {
          return true;
        }

        if (!(await canLeaveActiveDetail())) {
          return false;
        }

        restoreFocus = current.focus;
        publish({ active: null, diagnostic: null });
        return true;
      });
    },

    prepareForNavigation() {
      return enqueue(async () => {
        const current = snapshot.active;
        if (!current) {
          return true;
        }
        if (!(await canLeaveActiveDetail())) {
          return false;
        }

        restoreFocus = current.focus;
        publish({ active: null, diagnostic: null });
        return true;
      });
    },
  };

  return {
    controller,
    focusAfterClose() {
      if (snapshot.active) {
        return false;
      }
      const focused = focusSystemCollectionDetailTarget(restoreFocus);
      restoreFocus = {};
      if (snapshot.displayed) {
        publish({ displayed: null });
      }
      return focused;
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function runSystemCollectionNavigation(
  controller: SystemCollectionDetailController,
  transition: () => void | Promise<void>,
): Promise<boolean> {
  if (!(await controller.prepareForNavigation())) {
    return false;
  }
  await transition();
  return true;
}

export function systemCollectionDetailSelectionEquals(
  left: SystemCollectionDetailSelection,
  right: SystemCollectionDetailSelection,
): boolean {
  return (
    left.instanceKey === right.instanceKey &&
    left.presentationId === right.presentationId &&
    left.rowId === right.rowId
  );
}

export function focusSystemCollectionDetailTarget(
  options: SystemCollectionDetailFocusOptions,
): boolean {
  for (const resolveTarget of [
    options.returnFocus,
    options.fallbackFocus,
  ] as const) {
    let target: HTMLElement | null | undefined;
    try {
      target = resolveTarget?.();
    } catch {
      continue;
    }
    if (!target || target.isConnected === false) {
      continue;
    }
    try {
      target.focus({ preventScroll: true });
      return true;
    } catch {
      // Try the safe fallback when the original trigger cannot receive focus.
    }
  }
  return false;
}
