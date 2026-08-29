import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useAgentActorCatalog } from "./use-agent-actor-catalog";

test("late adapter diagnostic cannot replace the current source generation", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const oldDiagnostic = deferred<unknown>();
  const newDiagnostic = deferred<unknown>();
  mockNativeIpc(
    (command, args) => {
      if (command === "agent_actors_get") return catalogSnapshot();
      if (command === "agent_actors_diagnose_adapter") {
        const source = (args as { targetSpacePath: string }).targetSpacePath;
        return source === "/repo/old"
          ? oldDiagnostic.promise
          : newDiagnostic.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<CatalogHarness source="/repo/old" />);
      await nextTurn();
      await nextTurn();
    });
    await clickDiagnose(dom);
    expect(textOf(dom, "[data-pending-adapter]")).toBe("codex");

    await act(async () => {
      root.render(<CatalogHarness source="/repo/new" />);
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-pending-adapter]")).toBe("none");
    await clickDiagnose(dom);

    await act(async () => {
      newDiagnostic.resolve(diagnostic("new source detail"));
      await nextTurn();
    });
    expect(textOf(dom, "[data-diagnostic]")).toBe("new source detail");

    await act(async () => {
      oldDiagnostic.resolve(diagnostic("old source detail"));
      await nextTurn();
    });
    expect(textOf(dom, "[data-diagnostic]")).toBe("new source detail");
    expect(textOf(dom, "[data-pending-adapter]")).toBe("none");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function CatalogHarness({ source }: { source: string }) {
  const catalog = useAgentActorCatalog("/project", source);
  return (
    <>
      <button
        type="button"
        data-diagnose
        onClick={() => catalog.diagnose("codex")}
      />
      <span data-pending-adapter>{catalog.pendingAdapter ?? "none"}</span>
      <span data-diagnostic>
        {catalog.diagnostics.codex?.message ?? "none"}
      </span>
    </>
  );
}

function catalogSnapshot() {
  return {
    adapterDescriptors: [],
    bindings: [],
    ownerFingerprints: {},
    resolution: { actors: [], diagnostics: [] },
  };
}

function diagnostic(message: string) {
  return {
    adapter: "codex",
    authenticated: null,
    code: "auth_check_failed",
    executablePath: "/bin/codex",
    message,
    status: "unknown",
    version: "1.0",
  };
}

async function clickDiagnose(dom: JSDOM) {
  await act(async () => {
    dom.window.document
      .querySelector<HTMLButtonElement>("[data-diagnose]")!
      .click();
    await nextTurn();
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
