import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

if (process.env.SVODE_SCOPE_OWNER_ACTIONS_DOM !== "1") {
  test("scope owner header delete DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SCOPE_OWNER_ACTIONS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const commands: [string, Record<string, unknown>][] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 0,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        commands.push([command, args]);
        switch (command) {
          case "get_backlinks":
          case "list_tree_children":
            return [];
          case "get_page_detail_state":
            return { form: "folder", subpageCount: 1, otherFileCount: 0 };
          default:
            return null;
        }
      },
    },
  });

  const page = (path: string, title: string): Page => ({
    path,
    body: "",
    meta: { title, icon: null, created: "", updated: "", extra: {} },
  });
  let context = {
    page: page("tasks/README.md", "Tasks") as Page | null,
    schemaResult: null as object | null,
  };
  let onDeletePage: (page: Page) => void = () => {};
  const scopeSurface = await import("@/features/page/scope-surface");
  mock.module("@/features/page/scope-surface", () => ({
    ...scopeSurface,
    usePageDetailContext: () => ({
      ...context,
      spacePath: "/project/docs",
      projectPath: "/project",
      spaceId: "docs",
      setPage: () => {},
      reload: async () => {},
    }),
  }));
  const pageDetail = await import("@/features/page/detail");
  mock.module("@/features/page/detail", () => ({
    ...pageDetail,
    PageDetailActions: (props: { onDeletePage: (page: Page) => void }) => {
      onDeletePage = props.onDeletePage;
      return null;
    },
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { ScopeOwnerActions } = await import("./scope-owner-actions");
  const { artifactNavigationKey } = await import("@/features/navigation");
  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  async function requestDelete(
    ownerKind: ScopeOwnerRef["identityKind"],
    owner: Page,
    options: { inCollection?: boolean; readOnly?: boolean } = {},
  ) {
    context = {
      page: owner,
      schemaResult: options.inCollection ? { schema: {} } : null,
    };
    await act(async () =>
      root.render(
        <ScopeOwnerActions
          key={`${ownerKind}:${owner.path}:${options.readOnly}`}
          ownerKind={ownerKind}
          pinItem={{
            key: artifactNavigationKey("page", owner.path, "docs", null),
            title: owner.meta.title,
          }}
          readOnly={options.readOnly}
        />,
      ),
    );
    await act(async () => onDeletePage(owner));
    await settle();
  }

  function deleteDialog() {
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!dialog) return null;
    return {
      title: dialog.querySelector('[data-slot="alert-dialog-title"]')
        ?.textContent,
      description: dialog.querySelector(
        '[data-slot="alert-dialog-description"]',
      )?.textContent,
    };
  }

  async function clickDialogButton(label: string) {
    const button = [
      ...document.querySelectorAll('[role="alertdialog"] button'),
    ].find((element) => element.textContent === label) as
      | HTMLElement
      | undefined;
    if (!button) throw new Error(`no dialog button ${label}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Radix finishes closing the dialog after its own state update.
    await settle();
  }

  test("an owner header names the type of what its delete deletes", async () => {
    const cases: [
      ScopeOwnerRef["identityKind"],
      Page,
      boolean,
      { title: string; description: string },
    ][] = [
      [
        "collection-directory",
        page("tasks/README.md", "Tasks"),
        false,
        {
          title: "Delete collection?",
          description:
            "The collection “Tasks” will be deleted with its schema and all items.",
        },
      ],
      [
        "app-directory",
        page("board/README.md", "Board"),
        false,
        {
          title: "Delete app?",
          description: "The app “Board” will be deleted with its files.",
        },
      ],
      [
        "registered-space",
        page("README.md", "Docs home"),
        false,
        {
          title: "Delete page?",
          description: "The page “Docs home” will be deleted.",
        },
      ],
      [
        "page-directory",
        page("guide/README.md", "Guide"),
        false,
        {
          title: "Delete page?",
          description:
            "The page “Guide” will be deleted with its nested pages and files.",
        },
      ],
      [
        "page-directory",
        page("tasks/plan/README.md", "Plan"),
        true,
        {
          title: "Delete collection item?",
          description:
            "The collection item “Plan” will be deleted with its nested pages and files.",
        },
      ],
    ];
    for (const [ownerKind, owner, inCollection, expected] of cases) {
      await requestDelete(ownerKind, owner, { inCollection });
      expect(deleteDialog()).toEqual(expected);
      await clickDialogButton("Cancel");
      expect(deleteDialog()).toBeNull();
    }
    expect(commands.some(([command]) => command === "delete_content")).toBe(
      false,
    );
  });

  test("confirming deletes the owner and read-only shows no confirmation", async () => {
    commands.length = 0;
    await requestDelete(
      "collection-directory",
      page("tasks/README.md", "Tasks"),
    );
    await clickDialogButton("Delete");
    expect(deleteDialog()).toBeNull();
    expect(
      commands.filter(([command]) => command === "delete_content"),
    ).toEqual([
      [
        "delete_content",
        {
          space: "/project/docs",
          path: "tasks/README.md",
          projectPath: "/project",
        },
      ],
    ]);

    await requestDelete("app-directory", page("board/README.md", "Board"), {
      readOnly: true,
    });
    expect(deleteDialog()).toBeNull();
    await act(async () => root.unmount());
  });
}
