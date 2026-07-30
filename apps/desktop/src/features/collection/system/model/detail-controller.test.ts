import { expect, test } from "bun:test";

import {
  createSystemCollectionDetailControllerStore,
  focusSystemCollectionDetailTarget,
  runSystemCollectionNavigation,
} from "./detail-controller";
import type {
  SystemCollectionDetailRequest,
  SystemCollectionDetailSelection,
} from "./types";

const firstSelection: SystemCollectionDetailSelection = {
  instanceKey: "space:root:actors",
  presentationId: "contributors",
  rowId: "person:one",
};

const secondSelection: SystemCollectionDetailSelection = {
  ...firstSelection,
  rowId: "person:two",
};

function request(
  selection: SystemCollectionDetailSelection,
  input: Partial<SystemCollectionDetailRequest> = {},
): SystemCollectionDetailRequest {
  return {
    content: `Content ${selection.rowId}`,
    description: "Repository actor",
    selection,
    title: selection.rowId,
    ...input,
  };
}

function createStore() {
  return createSystemCollectionDetailControllerStore({
    guardErrorMessage: "Close check failed",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("open updates the same stable selection without running its close guard", async () => {
  const store = createStore();
  let guardCalls = 0;

  await store.controller.open(
    request(firstSelection, {
      canClose: () => {
        guardCalls += 1;
        return false;
      },
      content: "Initial actor",
    }),
  );
  const updated = await store.controller.open(
    request(firstSelection, {
      canClose: () => false,
      content: "Refreshed actor",
    }),
  );

  expect(updated).toBe(true);
  expect(guardCalls).toBe(0);
  expect(store.getSnapshot().active?.request.content).toBe("Refreshed actor");
});

test("replacement, explicit close, and identity-scoped disappeared-row close share one guard", async () => {
  const store = createStore();
  let allowClose = false;
  let guardCalls = 0;

  await store.controller.open(
    request(firstSelection, {
      canClose: () => {
        guardCalls += 1;
        return allowClose;
      },
    }),
  );

  expect(await store.controller.open(request(secondSelection))).toBe(false);
  expect(store.getSnapshot().active?.request.selection).toEqual(firstSelection);

  allowClose = true;
  expect(await store.controller.open(request(secondSelection))).toBe(true);
  expect(store.getSnapshot().active?.request.selection).toEqual(
    secondSelection,
  );
  expect(await store.controller.close(firstSelection)).toBe(true);
  expect(store.getSnapshot().active?.request.selection).toEqual(
    secondSelection,
  );

  expect(await store.controller.close(secondSelection)).toBe(true);
  expect(store.getSnapshot().active).toBeNull();
  expect(guardCalls).toBe(2);
});

test("guard throws veto the transition and surface a bounded detail diagnostic", async () => {
  const store = createStore();
  await store.controller.open(
    request(firstSelection, {
      canClose: () => {
        throw new Error("Save the actor before leaving");
      },
    }),
  );

  expect(await store.controller.close()).toBe(false);
  expect(store.getSnapshot().active?.request.selection).toEqual(firstSelection);
  expect(store.getSnapshot().diagnostic).toBe("Save the actor before leaving");
});

test("guard rejection vetoes close and uses the localized fallback for non-errors", async () => {
  const store = createStore();
  await store.controller.open(
    request(firstSelection, {
      canClose: () => Promise.reject("unavailable"),
    }),
  );

  expect(await store.controller.close()).toBe(false);
  expect(store.getSnapshot().active?.request.selection).toEqual(firstSelection);
  expect(store.getSnapshot().diagnostic).toBe("Close check failed");
});

test("save refresh can clear the dirty guard before programmatic close", async () => {
  const store = createStore();
  await store.controller.open(
    request(firstSelection, { canClose: () => false }),
  );

  expect(
    await store.controller.open(
      request(firstSelection, { canClose: () => true }),
    ),
  ).toBe(true);
  expect(await store.controller.close(firstSelection)).toBe(true);
  expect(store.getSnapshot().active).toBeNull();
  expect(store.getSnapshot().displayed?.request.selection).toEqual(
    firstSelection,
  );
  store.focusAfterClose();
  expect(store.getSnapshot().displayed).toBeNull();
});

test("queued intents never run close guards in parallel", async () => {
  const store = createStore();
  const firstGuard = deferred<boolean>();
  const secondGuard = deferred<boolean>();
  let guardIndex = 0;
  let activeGuards = 0;
  let maxActiveGuards = 0;

  await store.controller.open(
    request(firstSelection, {
      canClose: async () => {
        const gate = guardIndex++ === 0 ? firstGuard : secondGuard;
        activeGuards += 1;
        maxActiveGuards = Math.max(maxActiveGuards, activeGuards);
        const result = await gate.promise;
        activeGuards -= 1;
        return result;
      },
    }),
  );

  const closeResult = store.controller.close();
  const replacementResult = store.controller.open(request(secondSelection));
  await Promise.resolve();

  expect(store.getSnapshot().pending).toBe(true);
  expect(guardIndex).toBe(1);
  firstGuard.resolve(false);
  expect(await closeResult).toBe(false);
  await Promise.resolve();
  expect(guardIndex).toBe(2);

  secondGuard.resolve(true);
  expect(await replacementResult).toBe(true);
  expect(maxActiveGuards).toBe(1);
  expect(store.getSnapshot().pending).toBe(false);
  expect(store.getSnapshot().active?.request.selection).toEqual(
    secondSelection,
  );
});

test("navigation veto leaves app navigation state untouched", async () => {
  const store = createStore();
  let destination = "actors";
  await store.controller.open(
    request(firstSelection, { canClose: () => false }),
  );

  const navigated = await runSystemCollectionNavigation(
    store.controller,
    () => {
      destination = "sessions";
    },
  );

  expect(navigated).toBe(false);
  expect(destination).toBe("actors");
  expect(store.getSnapshot().active?.request.selection).toEqual(firstSelection);
});

test("focus restoration falls back when the original trigger disappeared", () => {
  let fallbackFocused = false;
  const focused = focusSystemCollectionDetailTarget({
    fallbackFocus: () =>
      ({
        focus: () => {
          fallbackFocused = true;
        },
        isConnected: true,
      }) as unknown as HTMLElement,
    returnFocus: () =>
      ({
        focus: () => {
          throw new Error("disconnected");
        },
        isConnected: false,
      }) as unknown as HTMLElement,
  });

  expect(focused).toBe(true);
  expect(fallbackFocused).toBe(true);
});

test("focus restoration prefers the surviving original trigger", () => {
  let triggerFocused = false;
  let fallbackFocused = false;
  const focused = focusSystemCollectionDetailTarget({
    fallbackFocus: () =>
      ({
        focus: () => {
          fallbackFocused = true;
        },
        isConnected: true,
      }) as unknown as HTMLElement,
    returnFocus: () =>
      ({
        focus: () => {
          triggerFocused = true;
        },
        isConnected: true,
      }) as unknown as HTMLElement,
  });

  expect(focused).toBe(true);
  expect(triggerFocused).toBe(true);
  expect(fallbackFocused).toBe(false);
});

test("focus restoration tolerates a throwing target resolver", () => {
  let fallbackFocused = false;
  const focused = focusSystemCollectionDetailTarget({
    fallbackFocus: () =>
      ({
        focus: () => {
          fallbackFocused = true;
        },
        isConnected: true,
      }) as unknown as HTMLElement,
    returnFocus: () => {
      throw new Error("trigger resolver failed");
    },
  });

  expect(focused).toBe(true);
  expect(fallbackFocused).toBe(true);
});
