import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  createCollectionDirectoryOwner,
  createPageOwner,
} from "../model/owners";
import { useScopeSurfaceStore } from "../model/surface-store";
import type { ScopeSurfaceContribution } from "../model/types";
import { ScopeSurfaceHost } from "./scope-surface-host";

const contribution: ScopeSurfaceContribution = {
  id: "collection",
  label: "Collection",
  order: 0,
  presentations: ["full"],
  appliesTo: () => true,
  icon: () => null,
  render: ({ owner }) => (
    <input data-testid="surface-focus" value={owner.ownerPath} readOnly />
  ),
};

test("owner retarget preserves the mounted scope surface and focus", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const previousOwner = owner("tasks");
  const nextOwner = owner("Задачи");
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {
      [previousOwner.ownerKey]: "collection" as const,
    },
    openRequestKeyByOwnerKey: { [previousOwner.ownerKey]: 7 },
  });

  try {
    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={previousOwner}
          presentation="full"
          contributions={[contribution]}
          header={null}
          openRequestKey={7}
          sessionKey={7}
        />,
      );
    });
    const focused = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="surface-focus"]',
    )!;
    focused.focus();

    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={nextOwner}
          presentation="full"
          contributions={[contribution]}
          header={null}
          openRequestKey={7}
          previousOwnerKey={previousOwner.ownerKey}
          sessionKey={7}
        />,
      );
    });

    const retargeted = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="surface-focus"]',
    )!;
    expect(retargeted).toBe(focused);
    expect(dom.window.document.activeElement).toBe(focused);
    expect(retargeted.value).toBe("Задачи");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("owner surface round trip preserves the mounted Readme session", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const targetOwner = owner("tasks");
  const contributions: ScopeSurfaceContribution[] = [
    {
      ...contribution,
      id: "readme",
      label: "Readme",
      render: () => <input data-testid="readme-session" defaultValue="draft" />,
    },
    {
      ...contribution,
      id: "collection",
      label: "Collection",
      render: () => <div data-testid="collection-session">Collection</div>,
    },
  ];
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: { [targetOwner.ownerKey]: "readme" as const },
    openRequestKeyByOwnerKey: {},
  });

  try {
    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={targetOwner}
          presentation="full"
          contributions={contributions}
          header={null}
          sessionKey="session"
        />,
      );
    });
    const readme = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="readme-session"]',
    )!;
    readme.value = "pending draft";
    readme.focus();

    await act(async () => {
      activateTab(dom, "Collection");
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    expect(
      Boolean(
        dom.window.document.querySelector('[data-testid="collection-session"]'),
      ),
    ).toBe(true);
    expect(
      dom.window.document.querySelector('[data-testid="readme-session"]'),
    ).toBe(readme);

    await act(async () => {
      activateTab(dom, "Readme");
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    const restored = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="readme-session"]',
    )!;
    expect(restored).toBe(readme);
    expect(restored.value).toBe("pending draft");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

const pageBase = {
  spaceId: "root",
  projectPath: "/repo",
  spacePath: "/repo",
  status: "ready" as const,
};
const pageContributions: ScopeSurfaceContribution[] = [
  {
    ...contribution,
    id: "readme",
    label: "Readme",
    presentations: ["full", "compact"],
    render: () => <textarea data-testid="page-editor" defaultValue="draft" />,
  },
  {
    ...contribution,
    id: "app",
    label: "App",
    presentations: ["full", "compact"],
    appliesTo: (owner) => owner.capabilities.includes("app"),
    render: () => <div>App viewport</div>,
  },
];

for (const presentation of ["full", "compact"] as const) {
  test(`${presentation} host serializes injected preparation, preserves blocked selection, and recovers from rejection`, async () => {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const target = createPageOwner({
      ...pageBase,
      form: "folder",
      ownerPath: "Note",
      contentPath: "Note/README.md",
      hasApp: true,
    });
    useScopeSurfaceStore.setState({
      surfaceByOwnerKey: {},
      openRequestKeyByOwnerKey: {},
    });
    let calls = 0;
    let settle!: (allowed: boolean) => void;
    let reject!: (error: Error) => void;
    const prepare = () => {
      calls += 1;
      return new Promise<boolean>((resolve, rejectPromise) => {
        settle = resolve;
        reject = rejectPromise;
      });
    };
    const compactChanges: string[] = [];
    const previousError = console.error;
    const errors: unknown[] = [];
    console.error = (error: unknown) => errors.push(error);
    try {
      await act(async () =>
        root.render(
          <ScopeSurfaceHost
            owner={target}
            presentation={presentation}
            contributions={pageContributions}
            header={null}
            compactSurfaceId="readme"
            onCompactSurfaceIdChange={(id) => compactChanges.push(id)}
            prepareForSurfaceChange={prepare}
          />,
        ),
      );
      const editor =
        dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
      editor.value = "unsaved draft";
      await act(async () => {
        activateTab(dom, "App");
        activateTab(dom, "App");
      });
      expect(calls).toBe(1);
      expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
      expect(
        dom.window.document.querySelector('[aria-busy="true"]') !== null,
      ).toBe(true);
      await act(async () => settle(false));
      expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
      expect(compactChanges).toEqual([]);
      expect(
        dom.window.document.querySelector('[aria-busy="true"]'),
      ).toBeNull();
      await act(async () => activateTab(dom, "App"));
      const failure = new Error("preparation failed");
      await act(async () => reject(failure));
      expect(errors).toEqual([failure]);
      expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
      expect(
        dom.window.document.querySelector('[aria-busy="true"]'),
      ).toBeNull();
      expect(dom.window.document.querySelector("textarea")).toBe(editor);
      expect(editor.value).toBe("unsaved draft");
      await act(async () => activateTab(dom, "App"));
      await act(async () => settle(true));
      expect(calls).toBe(3);
      if (presentation === "full") {
        expect(findTab(dom, "App").getAttribute("aria-selected")).toBe("true");
        expect(
          useScopeSurfaceStore.getState().surfaceByOwnerKey[target.ownerKey],
        ).toBe("app");
      } else {
        expect(compactChanges).toEqual(["app"]);
        expect(
          useScopeSurfaceStore.getState().surfaceByOwnerKey[target.ownerKey],
        ).toBe(undefined);
      }
    } finally {
      await act(async () => root.unmount());
      console.error = previousError;
      restoreGlobals();
      dom.window.close();
    }
  });
}

test("Page owner conversion and rename retain one Readme instance and applied request", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const leaf = createPageOwner({
    ...pageBase,
    form: "leaf",
    contentPath: "Note.md",
  });
  const folder = createPageOwner({
    ...pageBase,
    form: "folder",
    contentPath: "Note/README.md",
    ownerPath: "Note",
    hasApp: true,
  });
  const renamed = createPageOwner({
    ...pageBase,
    form: "folder",
    contentPath: "Renamed/README.md",
    ownerPath: "Renamed",
    hasApp: true,
  });
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {},
    openRequestKeyByOwnerKey: {},
  });
  const render = (
    owner: typeof leaf,
    previousOwnerKey?: typeof leaf.ownerKey,
  ) =>
    root.render(
      <ScopeSurfaceHost
        owner={owner}
        previousOwnerKey={previousOwnerKey}
        presentation="full"
        contributions={pageContributions}
        header={null}
        openIntent={{ kind: "default" }}
        openRequestKey={4}
        sessionKey="page-session"
      />,
    );
  try {
    await act(async () => render(leaf));
    expect(dom.window.document.querySelector('[role="tablist"]')).toBeNull();
    const editor =
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    editor.value = "pending transaction";
    editor.setSelectionRange(2, 8);
    await act(async () => render(folder, leaf.ownerKey));
    expect(dom.window.document.querySelector("textarea")).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(8);
    await act(async () => activateTab(dom, "App"));
    await act(async () => {
      useScopeSurfaceStore
        .getState()
        .applyOpenRequest(renamed.ownerKey, 99, "readme");
    });
    await act(async () => render(renamed, folder.ownerKey));
    expect(findTab(dom, "App").getAttribute("aria-selected")).toBe("true");
    expect(useScopeSurfaceStore.getState().openRequestKeyByOwnerKey).toEqual({
      [renamed.ownerKey]: 4,
    });
    expect(useScopeSurfaceStore.getState().surfaceByOwnerKey).toEqual({
      [renamed.ownerKey]: "app",
    });
    await act(async () => activateTab(dom, "Readme"));
    expect(dom.window.document.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("pending transaction");
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(8);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("Page default intents apply once across remount and unavailable App falls back safely", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const target = createPageOwner({
    ...pageBase,
    form: "folder",
    contentPath: "Note/README.md",
    ownerPath: "Note",
    hasApp: true,
  });
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: { [target.ownerKey]: "app" as const },
    openRequestKeyByOwnerKey: {},
  });
  const render = (request: number, hasApp = true, explicit = false) =>
    root.render(
      <ScopeSurfaceHost
        owner={{ ...target, capabilities: hasApp ? ["app"] : [] }}
        presentation="full"
        contributions={pageContributions}
        header={null}
        openIntent={
          explicit ? { kind: "target", surfaceId: "app" } : { kind: "default" }
        }
        openRequestKey={request}
        sessionKey={request}
      />,
    );
  try {
    await act(async () => render(1));
    expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
    await act(async () => activateTab(dom, "App"));
    await act(async () => render(1));
    expect(findTab(dom, "App").getAttribute("aria-selected")).toBe("true");
    await act(async () => root.render(null));
    await act(async () => render(1));
    expect(findTab(dom, "App").getAttribute("aria-selected")).toBe("true");
    await act(async () => render(2));
    expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
    await act(async () => render(3, true, true));
    expect(findTab(dom, "App").getAttribute("aria-selected")).toBe("true");
    await act(async () => render(3, false, true));
    expect(dom.window.document.querySelector('[role="tablist"]')).toBeNull();
    expect(
      useScopeSurfaceStore.getState().surfaceByOwnerKey[target.ownerKey],
    ).toBe("readme");
    expect(dom.window.document.querySelector("textarea") !== null).toBe(true);
    await act(async () => render(3, true, true));
    expect(findTab(dom, "Readme").getAttribute("aria-selected")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function findTab(dom: JSDOM, label: string) {
  return Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((tab) => tab.textContent === label)!;
}

function activateTab(dom: JSDOM, label: string) {
  findTab(dom, label).dispatchEvent(
    new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
    }),
  );
}

function owner(ownerPath: string) {
  return createCollectionDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath,
    status: "ready",
    hasSchema: true,
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
