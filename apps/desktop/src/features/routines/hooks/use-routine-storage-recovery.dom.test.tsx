import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { RoutineOwnerInput } from "../api/routines-api";
import { useRoutineStorageRecovery } from "./use-routine-storage-recovery";

const owner: RoutineOwnerInput = {
  ownerKind: "registered_space",
  ownerPath: ".",
  projectPath: "/project",
  spaceId: "space-a",
  spacePath: "/project/space-a",
};

test("storage recovery acknowledgement is single-flight and refreshes both owners", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const acknowledgement = deferred<void>();
  const refresh = deferred<void>();
  const calls: unknown[] = [];
  let refreshes = 0;
  let consentRetries = 0;
  mockNativeIpc((command, args) => {
    expect(command).toBe("routines_acknowledge_storage_recovery");
    calls.push(args);
    return acknowledgement.promise;
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <Harness
          owner={owner}
          refreshCatalog={() => {
            refreshes += 1;
            return refresh.promise;
          }}
          retryAutomaticConsent={() => {
            consentRetries += 1;
          }}
        />,
      );
      await nextTurn();
    });

    await act(async () => {
      const button = dom.window.document.querySelector<HTMLButtonElement>(
        "[data-acknowledge]",
      )!;
      button.click();
      button.click();
      await nextTurn();
    });
    expect(calls).toEqual([{ spacePath: owner.spacePath }]);
    expect(textOf(dom, "[data-phase]")).toBe("pending");

    await act(async () => {
      acknowledgement.resolve();
      await nextTurn();
    });
    expect(consentRetries).toBe(1);
    expect(refreshes).toBe(1);
    expect(textOf(dom, "[data-phase]")).toBe("pending");

    await act(async () => {
      refresh.resolve();
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("idle");
    expect(textOf(dom, "[data-error]")).toBe("");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({
  owner,
  refreshCatalog,
  retryAutomaticConsent,
}: {
  owner: RoutineOwnerInput;
  refreshCatalog(): Promise<unknown>;
  retryAutomaticConsent(): void;
}) {
  const recovery = useRoutineStorageRecovery({
    owner,
    refreshCatalog,
    retryAutomaticConsent,
  });
  return (
    <>
      <span data-phase>{recovery.pending ? "pending" : "idle"}</span>
      <span data-error>{recovery.error}</span>
      <button
        type="button"
        data-acknowledge
        onClick={() => void recovery.acknowledge()}
      />
    </>
  );
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
