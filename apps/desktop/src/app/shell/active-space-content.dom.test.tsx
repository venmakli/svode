import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

if (process.env.SVODE_ACTIVE_CONTENT_TEST !== "1") {
  test("Main content owner selection", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ACTIVE_CONTENT_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const spacePath = "/space";
  let tree: unknown[] = [];
  const renders: string[] = [];
  const describe = (owner: ScopeOwnerRef) =>
    `${owner.identityKind}:${owner.readmePath}:${owner.capabilities.join(",")}`;
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: () => ({
      fileTrees: { root: tree },
      rootSpaces: [
        {
          id: "root",
          name: "Root",
          icon: "",
          description: "",
          path: spacePath,
          hasSpaces: false,
          hasSchema: false,
          lastOpened: null,
          status: "ready",
          lfsState: "n/a",
        },
      ],
      spaces: [],
      activeRootId: "root",
      activeRootPath: spacePath,
    }),
  }));
  const realSpaceShell = await import("@/features/space/app-shell");
  mock.module("@/features/space/app-shell", () => ({
    ...realSpaceShell,
    EmptyProjectState: () => <div data-empty />,
  }));
  mock.module("./scope-surface-page", () => ({
    ScopeSurfacePage: ({ owner }: { owner: ScopeOwnerRef }) => {
      renders.push(`scope:${describe(owner)}`);
      return <div data-scope-owner={describe(owner)} />;
    },
  }));
  mock.module("./page-scope-surface", () => ({
    PageScopeSurface: ({ owner }: { owner: ScopeOwnerRef }) => {
      renders.push(`page:${describe(owner)}`);
      return <div data-page-owner={describe(owner)} />;
    },
  }));
  mock.module("@/features/artifact/app-shell", () => ({
    // A Page renders its surface; a document or media file hands its top
    // bar elements to the main header.
    ArtifactSurface: ({
      request,
      renderPageSurface,
      renderMainHeader,
    }: {
      request: { intent: { target: { semanticHint?: unknown } } };
      renderPageSurface: (layout: {
        header: () => ReactNode;
        children: ReactNode;
      }) => ReactNode;
      renderMainHeader: (header: object) => ReactNode;
    }) =>
      request.intent.target.semanticHint
        ? renderPageSurface({ header: () => null, children: null })
        : renderMainHeader({}),
  }));
  const { ActiveSpaceContent } = await import("./active-space-content");
  const { useMainHeaderContribution } =
    await import("./main-header-contribution");
  const {
    openArtifact,
    openScopeOwner,
    closeActiveContent,
    getActiveContentSelection,
  } = await import("@/features/artifact");

  async function fixture(
    facts: (path: string) => unknown,
    answered: Promise<void> = Promise.resolve(),
  ) {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    renders.length = 0;
    // A non-empty project whose loaded tree does not hold the target.
    tree = [
      {
        name: "Other.md",
        path: "Other.md",
        title: "Other",
        icon: null,
        has_changes: false,
        has_schema: false,
        kind: "page",
        children: [],
      },
    ];
    let reads = 0;
    mockNativeIpc(
      async (command, args) => {
        if (command !== "get_scope_owner_facts")
          throw new Error(`Unexpected IPC: ${command}`);
        reads += 1;
        await answered;
        return facts(String((args as { path: string }).path));
      },
      { shouldMockEvents: true },
    );
    closeActiveContent();
    const root = createRoot(dom.window.document.getElementById("app")!);
    const query = (selector: string) =>
      dom.window.document.querySelector(selector);
    return {
      query,
      reads: () => reads,
      render: async (extra?: ReactNode) => {
        await act(async () =>
          root.render(
            <>
              <ActiveSpaceContent />
              {extra}
            </>,
          ),
        );
      },
      settle: async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
      cleanup: async () => {
        await act(async () => root.unmount());
        closeActiveContent();
        clearNativeMocks();
        restore();
        dom.window.close();
      },
    };
  }

  function openPage(path: string) {
    openArtifact({
      spaceId: "root",
      path,
      sourceShape: /readme\.md$/i.test(path) ? "directory" : "file",
      semanticHint: { kind: "page" },
    });
  }

  test("a Page known to the sidebar opens with its capabilities before the resolver answers", async () => {
    let answer!: () => void;
    const f = await fixture(
      () => ({
        identity: "pageDirectory",
        ownerPath: "Docs",
        contentPath: "Docs/README.md",
        hasApp: true,
      }),
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    try {
      tree = [
        {
          name: "Docs",
          path: "Docs/README.md",
          title: "Docs",
          icon: null,
          has_changes: false,
          has_schema: false,
          has_app: true,
          kind: "page",
          source_shape: "directory",
          children: [],
        },
      ];
      openPage("Docs/README.md");
      await f.render();
      await f.settle();
      expect(renders[0]).toBe("page:page-directory:Docs/README.md:app");
      await act(async () => answer());
      await f.settle();
      expect(f.reads()).toBe(1);
      expect(
        f.query("[data-page-owner]")?.getAttribute("data-page-owner"),
      ).toBe("page-directory:Docs/README.md:app");
      expect(renders.every((entry) => entry.startsWith("page:"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("a Collection README opened outside the loaded tree resolves to the Collection owner, not a Page", async () => {
    const f = await fixture(() => ({
      identity: "collectionDirectory",
      ownerPath: "Deep/tasks",
      contentPath: "Deep/tasks/README.md",
      hasApp: true,
    }));
    try {
      openPage("Deep/tasks/README.md");
      await f.render();
      await f.settle();
      // The README was never shown as a Page while its owner resolved.
      expect(renders.some((entry) => entry.startsWith("page:"))).toBe(false);
      expect(
        f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
      ).toBe("collection-directory:Deep/tasks/README.md:collection,app");
      expect(f.query("[data-page-owner]")).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("an open Collection whose schema is gone keeps its owner session as the Page it became", async () => {
    let schema = true;
    const f = await fixture(() =>
      schema
        ? {
            identity: "collectionDirectory",
            ownerPath: "tasks",
            contentPath: "tasks/README.md",
            hasApp: false,
          }
        : {
            identity: "pageDirectory",
            ownerPath: "tasks",
            contentPath: "tasks/README.md",
            hasApp: false,
          },
    );
    try {
      openScopeOwner({ kind: "collection", path: "tasks", spaceId: "root" });
      await f.render();
      await f.settle();
      expect(
        f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
      ).toBe("collection-directory:tasks/README.md:collection");
      schema = false;
      const { emit } = await import("@/platform/native/events");
      await act(async () => {
        await emit("file:deleted", {
          space: spacePath,
          path: "tasks/schema.yaml",
        });
      });
      await f.settle();
      expect(
        f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
      ).toBe("page-directory:tasks/README.md:");
    } finally {
      await f.cleanup();
    }
  });

  test("a document in main hands the Changes of its one file to the main header", async () => {
    const f = await fixture(() => {
      throw new Error("a document has no owner facts");
    });
    let changes: unknown = undefined;
    function Header() {
      const current = useMainHeaderContribution()?.changes;
      useEffect(() => {
        changes = current;
      });
      return null;
    }
    try {
      openArtifact({
        spaceId: "root",
        path: "Docs/report.pdf",
        sourceShape: "file",
      });
      await f.render(<Header />);
      await f.settle();
      const selection = getActiveContentSelection().selection;
      expect(selection?.kind).toBe("artifact");
      expect(changes).toEqual({
        kind: "page",
        sourceShape: "file",
        spacePath,
        projectPath: spacePath,
        sessionKey:
          selection?.kind === "artifact"
            ? selection.request.sessionKey
            : undefined,
        path: "Docs/report.pdf",
        name: "report.pdf",
      });
      expect(f.reads()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("failed facts show the error with Retry instead of a reduced owner", async () => {
    let fail = true;
    const f = await fixture(() => {
      if (fail) throw new Error("facts unavailable");
      return {
        identity: "pageFile",
        ownerPath: "Note.md",
        contentPath: "Note.md",
        hasApp: false,
      };
    });
    try {
      openPage("Note.md");
      await f.render();
      await f.settle();
      expect(f.query("[data-page-owner]")).toBeNull();
      expect(
        f.query('[role="alert"]')?.textContent?.includes("facts unavailable"),
      ).toBe(true);
      fail = false;
      await act(async () =>
        (f.query('[role="alert"] button') as HTMLButtonElement).click(),
      );
      await f.settle();
      expect(f.query('[role="alert"]')).toBeNull();
      expect(
        f.query("[data-page-owner]")?.getAttribute("data-page-owner"),
      ).toBe("page-file:Note.md:");
    } finally {
      await f.cleanup();
    }
  });
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
