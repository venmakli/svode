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

interface SchemaColumn {
  name: string;
  type: string;
  options?: { name: string; color: string }[];
}

async function harness(
  options: {
    readError?: boolean;
    blocked?: boolean;
    fieldError?: unknown;
    schema?: SchemaColumn[];
    presentation?: "full" | "compact";
  } = {},
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
  let fieldDelay: Promise<void> | null = null;
  let readDelay: Promise<void> | null = null;
  let schema = options.schema;
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
        const snapshot = structuredClone(page);
        if (readDelay) await readDelay;
        return snapshot;
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
        if (fieldDelay) await fieldDelay;
        if (fieldFailure) throw options.fieldError ?? new Error("Save failed");
        const page = pages.get(String(input.filePath))!;
        const field = String(input.field);
        const updated = ["title", "icon", "description", "cover"].includes(
          field,
        )
          ? { ...page, meta: { ...page.meta, [field]: input.value } }
          : {
              ...page,
              meta: {
                ...page.meta,
                extra: { ...page.meta.extra, [field]: input.value },
              },
            };
        pages.set(page.path, updated);
        return structuredClone(updated);
      }
      if (command === "get_entry_schema")
        return schema ? { schema: { columns: schema, views: [] } } : null;
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
    return (
      <ScopeOwnerHeader
        readOnly={options.blocked}
        presentation={options.presentation}
      />
    );
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
    delayFields: (value: Promise<void> | null) => {
      fieldDelay = value;
    },
    delayReads: (value: Promise<void> | null) => {
      readDelay = value;
    },
    setSchema: (value: SchemaColumn[]) => {
      schema = value;
    },
    fileEvent: async (
      path: string,
      event = "file:changed",
      space: string = spacePath,
    ) => {
      const { emit } = await import("@/platform/native/events");
      await act(async () => {
        await emit(event, { space, path });
        await turn();
        await turn();
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      // Radix focus scopes dispatch their unmount event on the next turn.
      await turn();
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

test("a property draft whose save failed stays visible with a user-facing error", async () => {
  const view = await harness({
    fieldError: { kind: "unexpected", detail: "not a string" },
    schema: [{ name: "Status", type: "text" }],
  });
  try {
    view.pages.set("app-only/README.md", {
      path: "app-only/README.md",
      body: "",
      meta: {
        title: "App only",
        icon: null,
        created: "",
        updated: "",
        extra: { Status: "Todo" },
      },
    });
    await view.render();
    await act(async () => {
      await turn();
      await turn();
    });
    view.failField(true);
    await act(async () => {
      await view
        .context()
        .updateField("Status", "Done")
        .catch(() => undefined);
      await turn();
    });
    const text = view.dom.window.document.body.textContent ?? "";
    expect(text.includes("Done")).toBe(true);
    expect(text.includes("[object Object]")).toBe(false);
    expect(text.includes("Retry saving before leaving this Page")).toBe(true);
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

const README = "app-only/README.md";

function readmePage(
  meta: Partial<Page["meta"]> = {},
  body = "Local body",
): Page {
  return {
    path: README,
    body,
    source_version: "v1",
    meta: {
      title: "App only",
      icon: null,
      description: "Before",
      created: "2026-09-20T10:00:00Z",
      updated: "2026-09-20T10:00:00Z",
      extra: { Status: "Todo" },
      ...meta,
    },
  };
}

async function readyHarness(
  options: Parameters<typeof harness>[0] = {},
  page = readmePage(),
) {
  const view = await harness({
    schema: [{ name: "Status", type: "text" }],
    ...options,
  });
  view.pages.set(README, page);
  await act(async () => {
    await view.context().reload();
    await turn();
  });
  expect(view.context().status).toBe("ready");
  return view;
}

function propertyButton(dom: JSDOM, text: string) {
  return [...dom.window.document.querySelectorAll('[role="button"]')].find(
    (node) => node.textContent === text,
  ) as HTMLElement | undefined;
}

function inputWithValue(dom: JSDOM, value: string) {
  return [...dom.window.document.querySelectorAll("input, textarea")].find(
    (node) => (node as HTMLInputElement).value === value,
  ) as HTMLInputElement | undefined;
}

for (const presentation of ["full", "compact"] as const) {
  test(`${presentation} Page detail shows another writer's metadata and schema in place`, async () => {
    const view = await readyHarness({ presentation });
    try {
      const reads = () =>
        view.calls.filter((call) => call === "read_entry").length;
      const readsBefore = reads();
      view.pages.set(
        README,
        readmePage(
          {
            title: "External title",
            icon: "🌿",
            description: "External description",
            updated: "2026-09-28T10:00:00Z",
            extra: { Status: "Done" },
          },
          "External body",
        ),
      );
      await view.fileEvent("app-only/Other.md");
      await view.fileEvent(README, "file:changed", "/another-space");
      expect(reads()).toBe(readsBefore);

      await view.fileEvent(README);
      expect(reads()).toBe(readsBefore + 1);
      expect(view.context().status).toBe("ready");
      const shown = view.context().page!;
      expect(shown.meta.title).toBe("External title");
      expect(shown.meta.icon).toBe("🌿");
      expect(shown.meta.updated).toBe("2026-09-28T10:00:00Z");
      expect(shown.body).toBe("Local body");
      expect(Boolean(inputWithValue(view.dom, "External title"))).toBe(true);
      expect(Boolean(inputWithValue(view.dom, "External description"))).toBe(
        true,
      );
      expect(Boolean(propertyButton(view.dom, "Done"))).toBe(true);
      expect(propertyButton(view.dom, "Todo")).toBe(undefined);

      view.setSchema([
        { name: "Status", type: "text" },
        { name: "Priority", type: "text" },
      ]);
      await view.fileEvent("app-only/schema.yaml");
      expect(
        view
          .context()
          .schemaResult?.schema.columns.map((column) => column.name),
      ).toEqual(["Status", "Priority"]);
      expect(
        view.dom.window.document.body.textContent?.includes("Priority"),
      ).toBe(true);
      expect(view.context().status).toBe("ready");
    } finally {
      await view.cleanup();
    }
  });
}

test("a field saved during a refresh keeps its value and its echo changes nothing", async () => {
  const view = await readyHarness();
  try {
    const save = deferred<void>();
    view.delayFields(save.promise);
    let write!: Promise<void>;
    await act(async () => {
      write = view.context().updateField("Status", "Mine", { flush: true });
      await turn();
    });
    view.pages.set(
      README,
      readmePage({ description: "External", extra: { Status: "Theirs" } }),
    );
    const read = deferred<void>();
    view.delayReads(read.promise);
    await view.fileEvent(README);
    view.delayFields(null);
    await act(async () => {
      save.resolve();
      await write;
    });
    expect(view.context().metadataDrafts.size).toBe(0);
    await act(async () => {
      read.resolve();
      await turn();
      await turn();
    });
    view.delayReads(null);
    expect(view.context().page?.meta.extra.Status).toBe("Mine");
    expect(view.context().page?.meta.description).toBe("External");
    expect(Boolean(propertyButton(view.dom, "Mine"))).toBe(true);

    const shown = view.context().page;
    await view.fileEvent(README);
    expect(view.context().page).toBe(shown);
    expect(view.pages.get(README)?.meta.extra.Status).toBe("Mine");
  } finally {
    await view.cleanup();
  }
});

test("a refresh keeps focus, the typed value and an open property popover", async () => {
  const view = await readyHarness({
    schema: [
      { name: "Status", type: "text" },
      {
        name: "Tags",
        type: "multi_select",
        options: [
          { name: "red", color: "red" },
          { name: "blue", color: "blue" },
        ],
      },
    ],
  });
  try {
    await act(async () => {
      propertyButton(view.dom, "Todo")!.click();
      await turn();
    });
    const input = inputWithValue(view.dom, "Todo")!;
    await act(async () => {
      input.focus();
      const setValue = Object.getOwnPropertyDescriptor(
        view.dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(input, "Typing");
      input.dispatchEvent(
        new view.dom.window.Event("input", { bubbles: true }),
      );
      const propertyChange = new view.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
      await turn();
    });
    view.pages.set(
      README,
      readmePage({ description: "External", extra: { Status: "Todo" } }),
    );
    await view.fileEvent(README);
    expect(Boolean(inputWithValue(view.dom, "External"))).toBe(true);
    expect(view.dom.window.document.activeElement).toBe(input);
    expect(input.value).toBe("Typing");

    await act(async () => {
      input.blur();
      await turn();
      await turn();
    });
    await act(async () => {
      propertyButton(view.dom, "-")!.click();
      await turn();
    });
    // The trigger state does not depend on the portal, which a Radix module
    // loaded before these DOM globals never mounts.
    const popover = () =>
      view.dom.window.document.querySelector(
        '[data-slot="popover-trigger"][data-state="open"]',
      );
    expect(popover() === null).toBe(false);
    view.pages.set(
      README,
      readmePage({ description: "Again", extra: { Status: "Typing" } }),
    );
    await view.fileEvent(README);
    expect(Boolean(inputWithValue(view.dom, "Again"))).toBe(true);
    expect(popover() === null).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test("a late refresh of the previous target is ignored", async () => {
  const view = await readyHarness();
  try {
    view.pages.set("other/README.md", {
      ...readmePage({ title: "Other" }),
      path: "other/README.md",
    });
    view.pages.set(README, readmePage({ title: "Stale" }));
    const read = deferred<void>();
    view.delayReads(read.promise);
    await view.fileEvent(README);
    view.delayReads(null);
    await view.render("other");
    await act(async () => {
      read.resolve();
      await turn();
      await turn();
    });
    expect(view.context().page?.path).toBe("other/README.md");
    expect(view.context().page?.meta.title).toBe("Other");

    const reads = view.calls.filter((call) => call === "read_entry").length;
    await view.fileEvent(README);
    expect(view.calls.filter((call) => call === "read_entry").length).toBe(
      reads,
    );
  } finally {
    await view.cleanup();
  }
});

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
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
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
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
