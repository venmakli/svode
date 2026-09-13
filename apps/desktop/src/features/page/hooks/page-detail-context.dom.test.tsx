import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { Page } from "../model";
import type { PageDetailContextValue } from "./page-detail-context";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

async function harness(
  options: { readError?: boolean; blocked?: boolean } = {},
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restore = installDomGlobals(dom);
  const pages = new Map<string, Page>();
  const calls: string[] = [];
  let createDelay: Promise<void> | null = null;
  let createFailure = false;
  let fieldFailure = false;
  let partial = false;
  let context!: PageDetailContextValue;
  let session!: {
    prepareForNavigation(): Promise<boolean>;
    retryPersistence(): Promise<void>;
  };
  const spacePath = `/repo-df090-${Math.random()}`;
  mockNativeIpc(
    async (command, args) => {
      calls.push(command);
      const input = args as Record<string, unknown>;
      if (command === "repository_access_get")
        return {
          checkedAt: null,
          expiresAt: null,
          generation: 1,
          lastKnownStatus: null,
          reason: options.blocked ? "auth_required" : null,
          repositoryId: spacePath,
          status: options.blocked ? "read_only" : "local",
        };
      if (command === "read_entry") {
        if (options.readError) throw new Error("Invalid frontmatter");
        const page = pages.get(String(input.path));
        if (!page) throw new Error(`File not found: ${input.path}`);
        return structuredClone(page);
      }
      if (command === "create_entry") {
        if (createDelay) await createDelay;
        if (createFailure) throw new Error("Create failed");
        const path = `${input.parentPath}/README.md`;
        if (pages.has(path)) throw new Error("File already exists");
        const page: Page = {
          path,
          body: "",
          meta: {
            title: String(input.title),
            icon: null,
            created: "",
            updated: "",
            extra: {},
          },
        };
        pages.set(path, page);
        if (partial) throw new Error("Post-create failure");
        return structuredClone(page);
      }
      if (command === "update_entry_field") {
        if (fieldFailure) throw new Error("Save failed");
        const page = pages.get(String(input.filePath))!;
        const updated = {
          ...page,
          meta: { ...page.meta, [String(input.field)]: input.value },
        };
        pages.set(page.path, updated);
        return structuredClone(updated);
      }
      if (command === "get_entry_schema") return null;
      if (command === "list_content_tree_children") return [];
      return null;
    },
    { shouldMockEvents: true },
  );
  const { PageDetailProvider, usePageDetailContext } =
    await import("./page-detail-context");
  const { PageSurfaceSessionProvider, usePageSurfaceSession } =
    await import("./page-surface-context");
  const { ScopeOwnerHeader } = await import("@/features/scope-surfaces");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const root = createRoot(dom.window.document.getElementById("app")!);
  function Probe() {
    const detailContext = usePageDetailContext();
    const surfaceSession = usePageSurfaceSession();
    useEffect(() => {
      context = detailContext;
      session = surfaceSession;
    }, [detailContext, surfaceSession]);
    return <ScopeOwnerHeader readOnly={options.blocked} />;
  }
  async function render(ownerPath = "app-only") {
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <PageSurfaceSessionProvider
              displayName={ownerPath}
              displayPath={`${ownerPath}/README.md`}
              spacePath={spacePath}
              targetKey={ownerPath}
            >
              <PageDetailProvider
                spacePath={spacePath}
                projectPath={spacePath}
                spaceId="root"
                readmePath={`${ownerPath}/README.md`}
                ownerPath={ownerPath}
                onOpenPath={() => {}}
              >
                <Probe />
              </PageDetailProvider>
            </PageSurfaceSessionProvider>
          </TooltipProvider>
        </ThemeProvider>,
      );
      await turn();
      await turn();
    });
  }
  await render();
  return {
    dom,
    pages,
    calls,
    render,
    context: () => context,
    session: () => session,
    delay: (value: Promise<void>) => {
      createDelay = value;
    },
    failCreate: (value: boolean) => {
      createFailure = value;
    },
    failField: (value: boolean) => {
      fieldFailure = value;
    },
    partial: () => {
      partial = true;
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

test("missing header keeps the same description control and focus through shared creation", async () => {
  const view = await harness();
  try {
    expect(view.context().status).toBe("missing");
    expect(view.pages.size).toBe(0);
    const add = [...view.dom.window.document.querySelectorAll("button")].find(
      (node) => node.textContent?.toLowerCase().includes("add description"),
    )!;
    expect(Boolean(add)).toBe(true);
    await act(async () => {
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const input = view.dom.window.document.querySelector("textarea")!;
    expect(view.dom.window.document.activeElement).toBe(input);
    expect(view.pages.size).toBe(0);
    const delay = deferred<void>();
    view.delay(delay.promise);
    let writes!: Promise<unknown>;
    await act(async () => {
      writes = Promise.all([
        view.context().updateField("description", "a"),
        view.context().updateField("description", "latest"),
        view.context().updateField("icon", "🚀"),
        view.context().createReadme(),
      ]);
      await turn();
    });
    let navigated = false;
    let navigation!: Promise<boolean>;
    await act(async () => {
      navigation = view
        .session()
        .prepareForNavigation()
        .then((value) => {
          navigated = value;
          return value;
        });
      await turn();
    });
    expect(navigated).toBe(false);
    await act(async () => {
      delay.resolve();
      await writes;
      await navigation;
    });
    expect(view.calls.filter((call) => call === "create_entry").length).toBe(1);
    assert.equal(view.pages.get("app-only/README.md")?.meta.title, "app only");
    assert.equal(view.pages.get("app-only/README.md")?.meta.icon, "🚀");
    assert.equal(
      view.pages.get("app-only/README.md")?.meta.description,
      "latest",
    );
    expect(view.dom.window.document.querySelector("textarea")).toBe(input);
    expect(view.dom.window.document.activeElement).toBe(input);
    expect(navigated).toBe(true);
  } finally {
    await view.cleanup();
  }
}, 30_000);

test("external README is reconciled without overwriting body or unrelated metadata", async () => {
  const view = await harness();
  try {
    const external: Page = {
      path: "app-only/README.md",
      body: "External body",
      meta: {
        title: "External title",
        icon: "🌿",
        created: "",
        updated: "",
        extra: { custom: 4 },
      },
    };
    view.pages.set(external.path, external);
    await act(async () => {
      await view.context().updateField("description", "Mine", { flush: true });
    });
    expect(view.calls.includes("create_entry")).toBe(false);
    expect(view.pages.get(external.path)).toEqual({
      ...external,
      meta: { ...external.meta, description: "Mine" },
    });
  } finally {
    await view.cleanup();
  }
});

test("README appearing during pending creation is reread after conflict", async () => {
  const view = await harness();
  try {
    const delay = deferred<void>();
    view.delay(delay.promise);
    let write!: Promise<void>;
    await act(async () => {
      write = view.context().updateField("icon", "🚀");
      await turn();
    });
    const external: Page = {
      path: "app-only/README.md",
      body: "Keep external body",
      meta: {
        title: "External",
        description: "Keep description",
        icon: null,
        created: "",
        updated: "",
        extra: {},
      },
    };
    view.pages.set(external.path, external);
    await act(async () => {
      delay.resolve();
      await write;
    });
    expect(view.pages.get(external.path)).toEqual({
      ...external,
      meta: { ...external.meta, icon: "🚀" },
    });
    expect(view.calls.filter((call) => call === "create_entry").length).toBe(1);
  } finally {
    await view.cleanup();
  }
});

test("create and field failures retain drafts and session retry recovers partial success", async () => {
  const view = await harness();
  try {
    view.failCreate(true);
    await act(async () => {
      await assert.rejects(
        view.context().updateField("icon", "🚀"),
        new RegExp("Create failed"),
      );
    });
    expect(view.context().status).toBe("missing");
    expect(view.context().metadataDrafts.get("icon")?.value).toBe("🚀");
    await act(async () => {
      expect(await view.session().prepareForNavigation()).toBe(false);
    });
    view.failCreate(false);
    view.partial();
    view.failField(true);
    await act(async () => {
      await assert.rejects(
        view.context().retryWrites(),
        new RegExp("Save failed"),
      );
    });
    expect(view.pages.size).toBe(1);
    expect(view.context().status).toBe("ready");
    view.failField(false);
    await act(async () => {
      await view.session().retryPersistence();
    });
    expect(view.pages.get("app-only/README.md")?.meta.icon).toBe("🚀");
    expect(view.calls.filter((call) => call === "create_entry").length).toBe(2);
    await act(async () => {
      expect(await view.session().prepareForNavigation()).toBe(true);
    });
  } finally {
    await view.cleanup();
  }
});

test("read errors and blocked access cannot create; stale creation cannot adopt another target", async () => {
  for (const options of [{ readError: true }, { blocked: true }]) {
    const view = await harness(options);
    try {
      await act(async () => {
        await assert.rejects(
          view.context().updateField("icon", "🚀"),
          new RegExp("not editable"),
        );
      });
      expect(view.calls.includes("create_entry")).toBe(false);
    } finally {
      await view.cleanup();
    }
  }
  const view = await harness();
  try {
    const delay = deferred<void>();
    view.delay(delay.promise);
    let write!: Promise<unknown>;
    await act(async () => {
      write = view
        .context()
        .updateField("icon", "🚀")
        .catch((error: unknown) => error);
      await turn();
    });
    await view.render("other");
    await act(async () => {
      delay.resolve();
      await write;
    });
    expect(view.context().readmePath).toBe("other/README.md");
    expect(view.context().page).toBeNull();
    expect(view.calls.includes("update_entry_field")).toBe(false);
  } finally {
    await view.cleanup();
  }
});

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
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
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
