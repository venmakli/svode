import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { RoutineOwnerInput } from "../api/routines-api";
import { useRoutineAutomaticConsent } from "./use-routine-automatic-consent";

const spaceOwner: RoutineOwnerInput = {
  ownerKind: "registered_space",
  ownerPath: ".",
  projectPath: "/project",
  spaceId: "space-a",
  spacePath: "/project/space-a",
};

const collectionOwner: RoutineOwnerInput = {
  ownerKind: "collection_directory",
  ownerPath: "tasks",
  projectPath: "/project",
  spaceId: "space-a",
  spacePath: "/project/space-a",
};

test("owner navigation keeps unconfirmed and stale authority values isolated", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const spaceFirst = deferred<{ enabled: boolean }>();
  const collection = deferred<{ enabled: boolean }>();
  const spaceReturn = deferred<{ enabled: boolean }>();
  const calls: unknown[] = [];
  let spaceReads = 0;
  mockNativeIpc((command, args) => {
    if (command !== "routines_get_automatic_consent") {
      throw new Error(`Unexpected command: ${command}`);
    }
    calls.push(args);
    if ((args as { ownerPath: string }).ownerPath === "tasks") {
      return collection.promise;
    }
    spaceReads += 1;
    return spaceReads === 1 ? spaceFirst.promise : spaceReturn.promise;
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness owner={spaceOwner} />);
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("loading");
    expect(textOf(dom, "[data-owner-kind]")).toBe("space");

    await act(async () => {
      root.render(<Harness owner={collectionOwner} />);
      await nextTurn();
      spaceFirst.resolve({ enabled: true });
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("loading");
    expect(textOf(dom, "[data-owner-kind]")).toBe("collection");

    await act(async () => {
      collection.resolve({ enabled: false });
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("ready");
    expect(textOf(dom, "[data-enabled]")).toBe("off");

    await act(async () => {
      root.render(<Harness owner={spaceOwner} />);
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("loading");
    expect(textOf(dom, "[data-enabled]")).toBe("unknown");

    await act(async () => {
      spaceReturn.resolve({ enabled: true });
      await nextTurn();
    });
    expect(textOf(dom, "[data-phase]")).toBe("ready");
    expect(textOf(dom, "[data-enabled]")).toBe("on");
    expect(calls).toEqual([spaceOwner, collectionOwner, spaceOwner]);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("failed mutation re-reads the canonical owner value and skips same-value writes", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const mutation = deferred<{ enabled: boolean }>();
  const mutationArgs: unknown[] = [];
  let reads = 0;
  mockNativeIpc((command, args) => {
    if (command === "routines_get_automatic_consent") {
      reads += 1;
      return { enabled: false };
    }
    if (command === "routines_set_automatic_consent") {
      mutationArgs.push(args);
      return mutation.promise;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness owner={spaceOwner} />);
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-enabled]")).toBe("off");

    await clickAndFlush(dom, "[data-keep]");
    expect(mutationArgs).toEqual([]);

    await clickAndFlush(dom, "[data-change]");
    expect(textOf(dom, "[data-phase]")).toBe("pending");
    expect(mutationArgs).toEqual([{ ...spaceOwner, enabled: true }]);

    await act(async () => {
      mutation.reject(new Error("write failed"));
      await nextTurn();
      await nextTurn();
    });
    expect(reads).toBe(2);
    expect(textOf(dom, "[data-phase]")).toBe("ready");
    expect(textOf(dom, "[data-enabled]")).toBe("off");
    expect(textOf(dom, "[data-error]").includes("write failed")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("a late owner mutation cannot publish into the next owner", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const mutation = deferred<{ enabled: boolean }>();
  const mutationArgs: unknown[] = [];
  mockNativeIpc((command, args) => {
    if (command === "routines_get_automatic_consent") {
      return { enabled: false };
    }
    if (command === "routines_set_automatic_consent") {
      mutationArgs.push(args);
      return mutation.promise;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness owner={spaceOwner} />);
      await nextTurn();
      await nextTurn();
    });
    await clickAndFlush(dom, "[data-change]");
    expect(textOf(dom, "[data-phase]")).toBe("pending");

    await act(async () => {
      root.render(<Harness owner={collectionOwner} />);
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-enabled]")).toBe("off");

    await act(async () => {
      mutation.resolve({ enabled: true });
      await nextTurn();
    });
    expect(textOf(dom, "[data-owner-kind]")).toBe("collection");
    expect(textOf(dom, "[data-enabled]")).toBe("off");
    expect(mutationArgs).toEqual([{ ...spaceOwner, enabled: true }]);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("initial read failure can retry without guessing an off value", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const retryRead = deferred<{ enabled: boolean }>();
  let reads = 0;
  mockNativeIpc((command) => {
    if (command !== "routines_get_automatic_consent") {
      throw new Error(`Unexpected command: ${command}`);
    }
    reads += 1;
    if (reads === 1) throw new Error("read failed");
    return retryRead.promise;
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness owner={spaceOwner} />);
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-enabled]")).toBe("unknown");
    expect(textOf(dom, "[data-error]").includes("read failed")).toBe(true);

    await clickAndFlush(dom, "[data-retry]");
    expect(textOf(dom, "[data-phase]")).toBe("loading");

    await act(async () => {
      retryRead.resolve({ enabled: true });
      await nextTurn();
      await nextTurn();
    });
    expect(reads).toBe(2);
    expect(textOf(dom, "[data-phase]")).toBe("ready");
    expect(textOf(dom, "[data-enabled]")).toBe("on");
    expect(textOf(dom, "[data-error]")).toBe("");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({ owner }: { owner: RoutineOwnerInput }) {
  const state = useRoutineAutomaticConsent(owner);
  return (
    <>
      <span data-phase>
        {state.loading ? "loading" : state.pending ? "pending" : "ready"}
      </span>
      <span data-enabled>
        {state.enabled === null ? "unknown" : state.enabled ? "on" : "off"}
      </span>
      <span data-owner-kind>{state.ownerKind}</span>
      <span data-error>{state.error}</span>
      <button
        type="button"
        data-change
        onClick={() => void state.setEnabled(state.enabled !== true)}
      />
      <button
        type="button"
        data-keep
        onClick={() => void state.setEnabled(state.enabled ?? false)}
      />
      <button type="button" data-retry onClick={state.retry} />
    </>
  );
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function clickAndFlush(dom: JSDOM, selector: string) {
  await act(async () => {
    dom.window.document.querySelector<HTMLButtonElement>(selector)!.click();
    await nextTurn();
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
