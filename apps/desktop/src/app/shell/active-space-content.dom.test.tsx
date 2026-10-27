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
  // An unloaded root tree has no entry in the store yet.
  let treeLoaded = true;
  const renders: string[] = [];
  const describe = (owner: ScopeOwnerRef) =>
    `${owner.identityKind}:${owner.readmePath}:${owner.capabilities.join(",")}`;
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: () => ({
      fileTrees: treeLoaded ? { root: tree } : {},
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
  // Mounts of the owner surface: a retarget must keep the mounted one.
  let scopeMounts = 0;
  mock.module("./scope-surface-page", () => ({
    ScopeSurfacePage: ({
      owner,
      previousOwnerKey,
      sessionKey,
    }: {
      owner: ScopeOwnerRef;
      previousOwnerKey?: string;
      sessionKey?: string;
    }) => {
      renders.push(`scope:${describe(owner)}`);
      useEffect(() => {
        scopeMounts += 1;
      }, []);
      return (
        <div
          data-scope-owner={describe(owner)}
          data-previous-owner-key={previousOwnerKey ?? ""}
          data-session-key={sessionKey ?? ""}
        />
      );
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
      request: { intent: { target: { path: string; semanticHint?: unknown } } };
      renderPageSurface: (layout: {
        header: () => ReactNode;
        children: ReactNode;
      }) => ReactNode;
      renderMainHeader: (header: object) => ReactNode;
    }) => (
      <div data-artifact={request.intent.target.path}>
        {request.intent.target.semanticHint
          ? renderPageSurface({ header: () => null, children: null })
          : renderMainHeader({})}
      </div>
    ),
  }));
  const { ActiveSpaceContent } = await import("./active-space-content");
  const { useMainHeaderContribution } =
    await import("./main-header-contribution");
  const {
    openArtifact,
    openScopeOwner,
    closeActiveContent,
    getActiveContentSelection,
    retargetActiveContent,
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
    treeLoaded = true;
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

  // A project without child Spaces whose root tree is empty or not loaded yet.
  const emptyRootTrees = [
    ["empty", () => (tree = [])],
    ["not loaded", () => (treeLoaded = false)],
  ] as const;

  test("a selected root document or media file shows its surface while the root tree is empty or not loaded", async () => {
    for (const [state, emptyTree] of emptyRootTrees) {
      for (const path of ["notes.docx", "report.pdf", "photo.png"]) {
        const f = await fixture(() => {
          throw new Error("a document has no owner facts");
        });
        try {
          emptyTree();
          openArtifact({ spaceId: "root", path, sourceShape: "file" });
          await f.render();
          await f.settle();
          expect([state, Boolean(f.query("[data-empty]"))]).toEqual([
            state,
            false,
          ]);
          expect(
            f.query("[data-artifact]")?.getAttribute("data-artifact"),
          ).toBe(path);
        } finally {
          await f.cleanup();
        }
      }
    }
  });

  test("a selected Page, Collection and App show their surfaces while the root tree is empty or not loaded", async () => {
    const facts = (path: string) =>
      path === "tasks"
        ? {
            identity: "collectionDirectory",
            ownerPath: "tasks",
            contentPath: "tasks/README.md",
            hasApp: false,
          }
        : path === "tool"
          ? {
              identity: "appDirectory",
              ownerPath: "tool",
              contentPath: "tool/README.md",
              hasApp: true,
            }
          : {
              identity: "pageFile",
              ownerPath: "Note.md",
              contentPath: "Note.md",
              hasApp: false,
            };
    for (const [state, emptyTree] of emptyRootTrees) {
      const f = await fixture(facts);
      try {
        emptyTree();
        openPage("Note.md");
        await f.render();
        await f.settle();
        expect([state, Boolean(f.query("[data-empty]"))]).toEqual([
          state,
          false,
        ]);
        expect(
          f.query("[data-page-owner]")?.getAttribute("data-page-owner"),
        ).toBe("page-file:Note.md:");
        openScopeOwner({ kind: "collection", path: "tasks", spaceId: "root" });
        await f.render();
        await f.settle();
        expect(
          f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
        ).toBe("collection-directory:tasks/README.md:collection");
        openScopeOwner({
          kind: "app-directory",
          path: "tool",
          spaceId: "root",
        });
        await f.render();
        await f.settle();
        expect(
          f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
        ).toBe("app-directory:tool/README.md:app");
        expect(f.query("[data-empty]")).toBeNull();
      } finally {
        await f.cleanup();
      }
    }
  });

  test("only an empty selection shows the empty project state; a Space owner shows its home", async () => {
    for (const [state, emptyTree] of emptyRootTrees) {
      const f = await fixture(() => {
        throw new Error("no owner facts are read");
      });
      try {
        emptyTree();
        await f.render();
        expect([state, Boolean(f.query("[data-empty]"))]).toEqual([
          state,
          true,
        ]);
        openScopeOwner({ kind: "space", spaceId: "root" });
        await f.render();
        await f.settle();
        expect(f.query("[data-empty]")).toBeNull();
        expect(
          f.query("[data-scope-owner]")?.getAttribute("data-scope-owner"),
        ).toBe("registered-space:README.md:space");
        closeActiveContent();
        await f.render();
        expect(Boolean(f.query("[data-empty]"))).toBe(true);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("an App or Collection retargeted to its new folder keeps its mounted session and hands over its owner key", async () => {
    const f = await fixture((path) =>
      path === "tool" || path === "toolbox"
        ? {
            identity: "appDirectory",
            ownerPath: path,
            contentPath: `${path}/README.md`,
            hasApp: true,
          }
        : {
            identity: "collectionDirectory",
            ownerPath: path,
            contentPath: `${path}/README.md`,
            hasApp: false,
          },
    );
    const scope = () => f.query("[data-scope-owner]");
    try {
      for (const [kind, from, to, owner] of [
        [
          "app-directory",
          "tool",
          "toolbox",
          "app-directory:toolbox/README.md:app",
        ],
        [
          "collection",
          "tasks",
          "archive/tasks",
          "collection-directory:archive/tasks/README.md:collection",
        ],
      ] as const) {
        openScopeOwner({ kind, path: from, spaceId: "root" });
        await f.render();
        await f.settle();
        const sessionKey = scope()?.getAttribute("data-session-key");
        const mounts = scopeMounts;
        expect(scope()?.getAttribute("data-previous-owner-key")).toBe("");

        await act(async () => retargetActiveContent(from, to, "root"));
        await f.render();
        await f.settle();
        expect(scope()?.getAttribute("data-scope-owner")).toBe(owner);
        expect(scope()?.getAttribute("data-previous-owner-key")).toBe(
          `${kind === "collection" ? "collection" : "app"}:root:${from}`,
        );
        expect(scope()?.getAttribute("data-session-key")).toBe(sessionKey!);
        expect(scopeMounts).toBe(mounts);
      }
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
