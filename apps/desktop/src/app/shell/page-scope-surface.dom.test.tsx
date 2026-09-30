import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { Page } from "@/features/page";

if (process.env.SVODE_PAGE_SCOPE_TEST !== "1") {
  test("Artifact Page Scope integration", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_SCOPE_TEST: "1" },
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
  let mounts = 0;
  let unmounts = 0;
  let flushBody: () => Promise<void> = async () => {};
  let convert: (path: string) => void = () => {};
  let allowCollectionNavigation = true;
  let appBroken = false;
  const lifecycle: string[] = [];
  type Props = Record<string, unknown>;
  let headerProps: Props = {};
  let panelProps: Props = {};
  let actionsProps: Props = {};
  let deleteDialogProps: Props = {};
  const toasts: string[] = [];
  const record = (message: unknown) => {
    toasts.push(String(message));
  };
  mock.module("sonner", () => ({
    toast: Object.assign(record, {
      error: record,
      info: record,
      success: record,
      warning: record,
      dismiss: () => {},
      get: () => undefined,
    }),
    Toaster: () => null,
  }));
  mock.module("@/features/editor", () => ({
    PlateDocumentEditor: function Editor(props: {
      documentPath: string;
      initialPage: Page;
      readOnly: boolean;
      registerPersistence(
        kind: "body",
        participant: {
          flush: () => Promise<void>;
          discard: () => Promise<void>;
        },
      ): () => void;
      onDocumentPathChange(path: string): void;
    }) {
      convert = props.onDocumentPathChange;
      const { registerPersistence } = props;
      useEffect(() => {
        mounts += 1;
        const unregister = registerPersistence("body", {
          flush: () => flushBody(),
          discard: async () => {},
        });
        return () => {
          unmounts += 1;
          unregister();
        };
      }, [registerPersistence]);
      return (
        <textarea
          data-editor={props.documentPath}
          defaultValue={props.initialPage.body}
          readOnly={props.readOnly}
        />
      );
    },
  }));
  mock.module("@/features/document", () => ({
    probeDocumentTarget: () => ({ status: "no_match" }),
  }));
  mock.module("@/features/media", () => ({
    probeMediaTarget: () => ({ status: "no_match" }),
  }));
  mock.module("@/features/properties/panel", () => ({
    PropertyPanel: (props: Props) => {
      panelProps = props;
      const result = props.schemaResult as {
        schema: { columns: unknown[] };
      };
      return <div data-columns={result.schema.columns.length} />;
    },
  }));
  mock.module("@/features/page/ui/page-identity-header", () => ({
    PageIdentityHeader: (props: {
      title: string;
      titleError?: string | null;
      actions: ReactNode;
      readOnly: boolean;
    }) => {
      headerProps = props as unknown as Props;
      return (
        <header data-read-only={props.readOnly}>
          {props.title}
          {props.titleError ? <p data-title-error>{props.titleError}</p> : null}
          {props.actions}
        </header>
      );
    },
    PageIdentityHeaderSkeleton: () => <header>Loading</header>,
  }));
  mock.module("@/features/page/ui/page-detail-actions", () => ({
    PageDetailActions: (props: Props) => {
      actionsProps = props;
      return null;
    },
  }));
  mock.module("@/features/page/ui/page-system-fields", () => ({
    PageSystemFields: () => null,
  }));
  mock.module("@/features/page/ui/page-delete-dialog", () => ({
    PageDeleteDialog: (props: Props) => {
      deleteDialogProps = props;
      const page = props.page as Page | null;
      return page ? <div data-delete={page.path} /> : null;
    },
  }));
  // Radix portals need DOM globals before import; the real dialog has its
  // own DOM test, this one follows the leave flow through the shell.
  mock.module("@/features/page/ui/page-discard-dialog", () => ({
    PageDiscardDialog: ({
      confirmation,
      onResolve,
    }: {
      confirmation: { kind: string } | null;
      onResolve: (discard: boolean) => void;
    }) =>
      confirmation ? (
        <div data-page-discard-confirmation={confirmation.kind}>
          <button onClick={() => onResolve(false)}>Stay</button>
          <button onClick={() => onResolve(true)}>
            Discard changes and leave
          </button>
        </div>
      ) : null,
  }));
  mock.module(
    "@/features/collection/detail-peek/detail-peek",
    () => ({
      CollectionDetailPeekHost: () => null,
      useCollectionDetailController: () => ({
        close: async () => allowCollectionNavigation,
        open: async () => true,
      }),
    }),
  );
  mock.module("./app-with-variables", () => ({
    AppWithVariables: function App({
      owner,
    }: {
      owner: { ownerPath: string };
    }) {
      useEffect(() => {
        lifecycle.push("mount:app");
        return () => {
          lifecycle.push("unmount:app");
        };
      }, []);
      if (appBroken) throw new Error("App viewport failed");
      return <div data-app={owner.ownerPath} />;
    },
  }));
  mock.module("@/features/attachments/ui/attachments-surface", () => ({
    AttachmentsSurface: ({
      owner,
      readOnly,
    }: {
      owner: { contentPath: string; hasDirectCollection: boolean };
      readOnly: boolean;
    }) => (
      <div
        data-attachments={owner.contentPath}
        data-collection={owner.hasDirectCollection}
        data-read-only={readOnly}
      />
    ),
  }));
  const { ArtifactSurface } = await import("@/features/artifact/app-shell");
  const {
    useActiveContentSelection,
    closeActiveContent,
    getActiveContentPath,
  } = await import("@/features/artifact");
  const { useScopeOwner } = await import("@/features/scope-surfaces");
  const { openPage, publishPageTitleOutcome } =
    await import("@/features/page/navigation");
  const { useMainChangesTarget } = await import("@/features/changes");
  const { PageScopeSurface } = await import("./page-scope-surface");
  const { getSpaceTreeSyncSnapshot, registerRootSpace } =
    await import("@/features/space");
  const m = await import("@/paraglide/messages.js");
  function page(path: string): Page {
    return {
      path,
      body: "initial body",
      meta: { title: path, icon: null, created: "", updated: "", extra: {} },
    };
  }
  async function fixture(
    initialPath: string,
    folder = false,
    options: {
      readFailures?: number;
      missing?: boolean;
      schemaColumns?: number;
      fieldError?: unknown;
    } = {},
  ) {
    const dom = new JSDOM("<!doctype html><div id=app></div>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restore = installDomGlobals(dom);
    appBroken = false;
    mounts = 0;
    unmounts = 0;
    lifecycle.length = 0;
    allowCollectionNavigation = true;
    flushBody = async () => {};
    let hasApp = folder;
    let ownerFactReads = 0;
    let status = "local";
    let reads = 0;
    let readFailures = options.readFailures ?? 0;
    let missing = options.missing ?? false;
    let externalTitle: string | null = null;
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    headerProps = {};
    panelProps = {};
    actionsProps = {};
    deleteDialogProps = {};
    const spacePath = `/df104-${Date.now()}-${Math.random()}`;
    registerRootSpace({
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
    });
    mockNativeIpc(
      (command, args) => {
        calls.push({
          command,
          args: (args ?? {}) as Record<string, unknown>,
        });
        const input = (args ?? {}) as Record<string, unknown>;
        if (command === "navigation_expanded_paths") return [];
        if (command === "navigation_save_expanded_paths") return null;
        if (command === "list_tree_children")
          return input.parentPath === null
            ? [
                {
                  name: "Taken.md",
                  path: "Taken.md",
                  title: "Taken",
                  icon: null,
                  has_changes: false,
                  has_schema: false,
                },
              ]
            : [];
        if (command === "update_page_field") {
          if (options.fieldError) throw options.fieldError;
          const updated = page(String(input.filePath));
          return input.field === "icon"
            ? { ...updated, meta: { ...updated.meta, icon: input.value } }
            : updated;
        }
        if (command === "delete_content") return null;
        if (command === "duplicate_page")
          return { ...page("Note copy.md"), warnings: [] };
        if (command === "repository_access_get")
          return {
            status,
            repositoryId: spacePath,
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            reason: status === "local" ? null : "auth_required",
            lastKnownStatus: null,
          };
        if (command === "read_page") {
          reads += 1;
          if (missing) throw `File not found: ${String(input.path)}`;
          if (readFailures > 0) {
            readFailures -= 1;
            throw new Error("Invalid frontmatter");
          }
          const read = page(String(args && "path" in args ? args.path : ""));
          return externalTitle
            ? { ...read, meta: { ...read.meta, title: externalTitle } }
            : read;
        }
        if (command === "get_page_schema")
          return options.schemaColumns
            ? {
                schema: {
                  columns: Array.from(
                    { length: options.schemaColumns },
                    (_, index) => ({ name: `Field ${index}`, type: "text" }),
                  ),
                  views: [],
                },
              }
            : null;
        if (command === "get_scope_owner_facts") {
          ownerFactReads += 1;
          const path = String(input.path);
          const folder = /.\/readme\.md$/i.test(path);
          return {
            identity: folder ? "pageDirectory" : "pageFile",
            ownerPath: folder ? path.replace(/\/readme\.md$/i, "") : path,
            contentPath: path,
            hasApp: folder && hasApp,
          };
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
      { shouldMockEvents: true },
    );
    closeActiveContent();
    openPage(initialPath, "root");
    function Harness() {
      const { selection, activePathRetarget } = useActiveContentSelection();
      const changes = useMainChangesTarget();
      const targetPath =
        selection?.kind === "artifact"
          ? selection.request.intent.target.path
          : null;
      const { owner } = useScopeOwner({
        target: targetPath
          ? {
              spaceId: "root",
              spacePath,
              projectPath: spacePath,
              path: targetPath,
            }
          : null,
        retainPrevious: activePathRetarget?.path === targetPath,
      });
      if (selection?.kind === "artifact" && !owner)
        return <output data-owner-loading />;
      if (selection?.kind !== "artifact")
        return (
          <output
            data-selection={
              selection
                ? `${selection.kind}:${selection.request.owner.kind}`
                : ""
            }
          />
        );
      const request = selection.request;
      return (
        <div data-scroll style={{ overflowY: "auto", height: 400 }}>
          <output
            data-changes={changes?.path}
            data-changes-kind={changes?.kind}
            data-changes-shape={
              changes && "sourceShape" in changes ? changes.sourceShape : ""
            }
          />
          <ArtifactSurface
            request={request}
            spacePath={spacePath}
            projectPath={spacePath}
            spaceId="root"
            pageSessionKey={`root:${request.sessionKey}`}
            retainSurfaceDuringRetarget={
              activePathRetarget?.path === request.intent.target.path
            }
            renderPageSurface={(layout) =>
              owner ? (
                <PageScopeSurface
                  {...layout}
                  owner={owner}
                  sessionKey={request.sessionKey}
                />
              ) : null
            }
          />
        </div>
      );
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    async function render() {
      await act(async () => {
        root.render(<Harness />);
        await settle();
      });
      await act(settle);
    }
    await render();
    return {
      dom,
      spacePath,
      render,
      calls,
      /** Parents the Page asked the sidebar tree to reload since `from`. */
      treeReloads: (from: number) =>
        calls
          .slice(from)
          .filter(({ command }) => command === "list_tree_children")
          .map(({ args }) => args.parentPath),
      reads: () => reads,
      writeExternally: async (path: string, title: string) => {
        externalTitle = title;
        const { emit } = await import("@/platform/native/events");
        await act(async () => {
          await emit("file:changed", { space: spacePath, path });
          await settle();
        });
      },
      disappear: async (path: string, event: string) => {
        missing = true;
        const { emit } = await import("@/platform/native/events");
        await act(async () => {
          await emit(event, { space: spacePath, path });
          await settle();
        });
      },
      marker: async (value: boolean) => {
        hasApp = value;
        const path = getActiveContentPath() ?? "";
        const { emit } = await import("@/platform/native/events");
        await act(async () => {
          await emit(value ? "file:created" : "file:deleted", {
            space: spacePath,
            path: `${path.replace(/\/readme\.md$/i, "")}/app.yaml`,
          });
          await settle();
        });
      },
      ownerFactReads: () => ownerFactReads,
      access: async (value: string) => {
        status = value;
        await act(async () => {
          dom.window.dispatchEvent(new dom.window.Event("focus"));
          await settle();
        });
      },
      remount: async () => {
        await act(async () => root.render(null));
        await render();
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
  test("Artifact Page conversion/rename retains editor transaction and common owner contributions", async () => {
    const f = await fixture("Note.md");
    try {
      const editor =
        f.dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(editor !== null).toBe(true);
      expect(
        f.dom.window.document.querySelector('[role="tablist"]'),
      ).toBeNull();
      editor.value = "pending transaction";
      editor.setSelectionRange(2, 8);
      await act(async () => {
        convert("Note/README.md");
        await settle();
      });
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      expect(editor.dataset.editor).toBe("Note/README.md");
      expect(mounts).toBe(1);
      expect(f.reads()).toBe(1);
      expect(tabs(f.dom).length).toBe(2);
      await f.marker(true);
      expect(tabs(f.dom).length).toBe(3);
      const scroller =
        f.dom.window.document.querySelector<HTMLElement>("[data-scroll]")!;
      scroller.scrollTop = 320;
      await clickTab(f.dom, 1);
      scroller.scrollTop = 0;
      expect(editor.closest("[hidden]") !== null).toBe(true);
      await act(async () => {
        publishPageTitleOutcome(
          f.spacePath,
          "Note/README.md",
          page("Renamed/README.md"),
        );
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(editor.dataset.editor).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-changes]")
          ?.getAttribute("data-changes"),
      ).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-changes]")
          ?.getAttribute("data-changes-kind"),
      ).toBe("page");
      expect(
        f.dom.window.document
          .querySelector("[data-changes]")
          ?.getAttribute("data-changes-shape"),
      ).toBe("directory");
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-attachments"),
      ).toBe("Renamed/README.md");
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-collection"),
      ).toBe("false");
      expect(lifecycle).toEqual(["mount:app", "unmount:app"]);
      await clickTab(f.dom, 0);
      expect(scroller.scrollTop).toBe(320);
      expect(editor.closest("[hidden]")).toBeNull();
      expect(editor.value).toBe("pending transaction");
      expect(editor.selectionStart).toBe(2);
      expect(editor.selectionEnd).toBe(8);
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
    } finally {
      await f.cleanup();
    }
  });
  test("Page serializes pending flush, retains failed save recovery and respects Collection guard", async () => {
    const f = await fixture("Guard/README.md", true);
    try {
      let calls = 0;
      let release!: () => void;
      flushBody = () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      await clickTab(f.dom, 1);
      await clickTab(f.dom, 2);
      expect(calls).toBe(1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await act(async () => {
        release();
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await clickTab(f.dom, 0);
      flushBody = async () => {
        throw new Error("write failed");
      };
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      expect(
        f.dom.window.document.querySelector('[role="alert"]') !== null,
      ).toBe(true);
      expect(
        f.dom.window.document.querySelector('[aria-busy="true"]'),
      ).toBeNull();
      flushBody = async () => {};
      allowCollectionNavigation = false;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      allowCollectionNavigation = true;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(mounts).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  test("a blocked Page asks before leaving: staying keeps its session, discarding opens the latest target", async () => {
    const f = await fixture("Blocked.md");
    const doc = f.dom.window.document;
    const editor = () =>
      doc.querySelector("[data-editor]")?.getAttribute("data-editor");
    const button = (text: string) =>
      [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
      )!;
    try {
      flushBody = async () => {
        throw { kind: "source_busy", path: "Blocked.md" };
      };
      await act(async () => {
        openPage("Other.md", "root");
        await settle();
      });
      expect(
        doc.querySelector("[data-page-discard-confirmation=leave]") !== null,
      ).toBe(true);
      expect(editor()).toBe("Blocked.md");
      await act(async () => {
        button("Stay").click();
        await settle();
      });
      expect(doc.querySelector("[data-page-discard-confirmation]")).toBeNull();
      expect(editor()).toBe("Blocked.md");
      expect(doc.querySelector('[role="alert"]') !== null).toBe(true);

      await act(async () => {
        closeActiveContent();
        await settle();
      });
      expect(
        doc.querySelector("[data-page-discard-confirmation=leave]") !== null,
      ).toBe(true);
      await act(async () => {
        openPage("Latest.md", "root");
        await settle();
      });
      const readsBefore = f.reads();
      await act(async () => {
        button("Discard changes and leave").click();
        await settle();
      });
      await f.render();
      expect(editor()).toBe("Latest.md");
      // The metadata draft was dropped by reading the saved Page again.
      expect(f.reads() > readsBefore).toBe(true);
      expect(mounts).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
  test("Page open applies default once, remount preserves selection, marker fallback and repository recovery work", async () => {
    const f = await fixture("Open/README.md", true);
    try {
      await clickTab(f.dom, 1);
      await act(async () => {
        openPage("Open/README.md", "root");
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await f.remount();
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      await f.marker(false);
      expect(tabs(f.dom).length).toBe(2);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await f.marker(true);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      await f.access("read_only");
      expect(f.dom.window.document.querySelector("textarea")?.readOnly).toBe(
        true,
      );
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document
          .querySelector("[data-attachments]")
          ?.getAttribute("data-read-only"),
      ).toBe("true");
      await f.access("local");
      expect(f.dom.window.document.querySelector("textarea")?.readOnly).toBe(
        false,
      );
      const before = unmounts;
      await act(async () => {
        openPage("Other/README.md", "root");
        await settle();
      });
      await act(settle);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
      expect(unmounts).toBe(before + 1);
      await act(async () => {
        openPage("Open/README.md", "root");
        await settle();
      });
      await act(settle);
      expect(tabs(f.dom)[0]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      await f.cleanup();
    }
  });
  test("a pending Page flush follows rename to the current owner key", async () => {
    const f = await fixture("Pending/README.md", true);
    try {
      let release!: () => void;
      flushBody = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      await clickTab(f.dom, 1);
      await act(async () => {
        publishPageTitleOutcome(
          f.spacePath,
          "Pending/README.md",
          page("Saved/README.md"),
        );
        await settle();
      });
      await act(async () => {
        release();
        await settle();
      });
      expect(tabs(f.dom)[1]?.getAttribute("aria-selected")).toBe("true");
      expect(
        f.dom.window.document
          .querySelector("[data-app]")
          ?.getAttribute("data-app"),
      ).toBe("Saved");
      expect(mounts).toBe(1);
    } finally {
      flushBody = async () => {};
      await f.cleanup();
    }
  });

  test("an App render failure stays inside its common surface boundary", async () => {
    const f = await fixture("Broken/README.md", true);
    const previousError = console.error;
    console.error = () => {};
    try {
      const editor = f.dom.window.document.querySelector("textarea");
      appBroken = true;
      await clickTab(f.dom, 1);
      expect(tabs(f.dom).length).toBe(3);
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      await clickTab(f.dom, 2);
      expect(
        f.dom.window.document.querySelector("[data-attachments]") !== null,
      ).toBe(true);
      await clickTab(f.dom, 0);
      expect(f.dom.window.document.querySelector("textarea")).toBe(editor);
      expect(mounts).toBe(1);
    } finally {
      console.error = previousError;
      await f.cleanup();
    }
  });

  test("a full Page shows another writer's metadata in place without re-creating its editor", async () => {
    const f = await fixture("Note.md");
    const doc = f.dom.window.document;
    try {
      expect(
        doc.querySelector("[data-changes]")?.getAttribute("data-changes-shape"),
      ).toBe("file");
      const editor = doc.querySelector("textarea")!;
      editor.value = "local body draft";
      await f.writeExternally("Note.md", "Renamed by Routine");
      expect(
        doc
          .querySelector("header")
          ?.textContent?.includes("Renamed by Routine"),
      ).toBe(true);
      expect(doc.querySelector("textarea")).toBe(editor);
      expect(editor.value).toBe("local body draft");
      expect(mounts).toBe(1);
      expect(f.reads()).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("a full Page that cannot be read shows the error with Retry and loads on retry", async () => {
    const f = await fixture("Broken.md", false, { readFailures: 1 });
    const doc = f.dom.window.document;
    try {
      expect(doc.querySelector("textarea")).toBeNull();
      expect(doc.body.textContent?.includes("Could not read this page")).toBe(
        true,
      );
      expect(doc.body.textContent?.includes("Invalid frontmatter")).toBe(true);
      expect(doc.body.textContent?.includes("Create README.md")).toBe(false);
      const retry = [...doc.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      )!;
      await act(async () => {
        retry.click();
        await settle();
      });
      expect(doc.querySelector("textarea")?.dataset.editor).toBe("Broken.md");
      expect(f.reads()).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("a missing root readme.md hands over to the Space owner", async () => {
    const f = await fixture("readme.md", false, { missing: true });
    try {
      await act(settle);
      expect(
        f.dom.window.document
          .querySelector("[data-selection]")
          ?.getAttribute("data-selection"),
      ).toBe("scope-owner:space");
    } finally {
      await f.cleanup();
    }
  });

  test("a full Page whose file is gone closes with a toast; a gone root readme.md opens the Space owner", async () => {
    for (const [path, event] of [
      ["Note.md", "file:changed"],
      ["Folder/README.md", "file:deleted"],
      ["readme.md", "file:deleted"],
    ] as const) {
      toasts.length = 0;
      const f = await fixture(path, path.includes("/"));
      const doc = f.dom.window.document;
      try {
        expect(doc.querySelector("textarea")?.dataset.editor).toBe(path);
        await f.disappear(path, event);
        expect(
          doc.querySelector("[data-selection]")?.getAttribute("data-selection"),
        ).toBe(path === "readme.md" ? "scope-owner:space" : "");
        expect(toasts).toEqual([m.editor_file_deleted()]);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("a full Page title name conflict stays inline and does not block leaving", async () => {
    const f = await fixture("Note.md", false, {
      fieldError: {
        kind: "page_name_conflict",
        conflict: {
          parentPath: "",
          conflicts: [{ path: "Other.md", title: "Other" }],
        },
      },
    });
    const doc = f.dom.window.document;
    const titleError = () =>
      doc.querySelector("[data-title-error]")?.textContent ?? "";
    try {
      await act(async () => {
        await getSpaceTreeSyncSnapshot().loadTreeChildren("root", "");
      });
      await act(async () => {
        (headerProps.onTitleChange as (value: string) => void)("taken");
        await settle();
      });
      expect(titleError().includes("Taken.md")).toBe(true);
      expect(
        f.calls.some(({ command }) => command === "update_page_field"),
      ).toBe(false);
      await act(async () => {
        (headerProps.onTitleChange as (value: string) => void)("Other");
        await settle();
      });
      expect(titleError().includes("Other.md")).toBe(true);
      expect(doc.querySelector('[role="alert"]')).toBeNull();
      await act(async () => {
        openPage("Next.md", "root");
        await settle();
      });
      expect(doc.querySelector("[data-page-discard-confirmation]")).toBeNull();
      expect(doc.querySelector("textarea")?.dataset.editor).toBe("Next.md");
    } finally {
      await f.cleanup();
    }
  });

  test("full Page metadata save syncs the tree and a schema change from the panel is shown", async () => {
    const f = await fixture("Folder/Note.md", false, { schemaColumns: 1 });
    const doc = f.dom.window.document;
    try {
      expect(
        doc.querySelector("[data-columns]")?.getAttribute("data-columns"),
      ).toBe("1");
      const before = f.calls.length;
      await act(async () => {
        (headerProps.onIconChange as (value: string) => void)("🚀");
        await settle();
      });
      expect(
        f.calls.find(({ command }) => command === "update_page_field")?.args
          .field,
      ).toBe("icon");
      expect(f.treeReloads(before)).toEqual(["Folder"]);
      await act(async () => {
        (panelProps.onSchemaChange as (value: unknown) => void)({
          schema: {
            columns: [
              { name: "Field 0", type: "text" },
              { name: "Field 1", type: "text" },
            ],
            views: [],
          },
        });
        await settle();
      });
      expect(
        doc.querySelector("[data-columns]")?.getAttribute("data-columns"),
      ).toBe("2");
    } finally {
      await f.cleanup();
    }
  });

  test("full Page delete, duplicate and conversions keep their tree and navigation effects", async () => {
    const f = await fixture("Note.md");
    const doc = f.dom.window.document;
    const editor = () =>
      doc.querySelector("[data-editor]")?.getAttribute("data-editor");
    try {
      await act(async () => {
        (actionsProps.onDeletePage as (page: Page) => void)(page("Note.md"));
        await settle();
      });
      expect(
        doc.querySelector("[data-delete]")?.getAttribute("data-delete"),
      ).toBe("Note.md");
      const before = f.calls.length;
      await act(async () => {
        (deleteDialogProps.onDeletePage as (page: Page) => void)(
          page("Note.md"),
        );
        await settle();
      });
      expect(
        f.calls.find(({ command }) => command === "delete_content")?.args.path,
      ).toBe("Note.md");
      expect(f.treeReloads(before)).toEqual([null]);
      expect(doc.querySelector("[data-delete]")).toBeNull();

      await act(async () => {
        await (actionsProps.onDuplicatePage as (page: Page) => Promise<void>)(
          page("Note.md"),
        );
        await settle();
      });
      expect(editor()).toBe("Note copy.md");

      await act(async () => {
        (actionsProps.onConverted as (page: Page, nested: boolean) => void)(
          page("Leaf.md"),
          false,
        );
        await settle();
      });
      expect(editor()).toBe("Leaf.md");

      await act(async () => {
        (actionsProps.onConverted as (page: Page, nested: boolean) => void)(
          page("Col/README.md"),
          true,
        );
        await settle();
      });
      expect(
        doc.querySelector("[data-selection]")?.getAttribute("data-selection"),
      ).toBe("scope-owner:collection");
    } finally {
      await f.cleanup();
    }
  });

  function tabs(dom: JSDOM) {
    return Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
  }
  async function clickTab(dom: JSDOM, index: number) {
    await act(async () => {
      tabs(dom)[index]!.dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      await settle();
    });
  }
  async function settle() {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
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
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      CustomEvent: dom.window.CustomEvent,
      DOMRect: dom.window.DOMRect,
      Element: dom.window.Element,
      Event: dom.window.Event,
      FocusEvent: dom.window.FocusEvent,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      KeyboardEvent: dom.window.KeyboardEvent,
      MouseEvent: dom.window.MouseEvent,
      MutationObserver: dom.window.MutationObserver,
      Node: dom.window.Node,
      PointerEvent: dom.window.MouseEvent,
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
}
