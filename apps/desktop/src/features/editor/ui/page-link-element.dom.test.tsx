import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

import type { SearchItem } from "@/features/search";

if (process.env.SVODE_PAGE_LINK_ELEMENT_DOM !== "1") {
  test("page link element DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_LINK_ELEMENT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  // Slate uses these when an editable mounts.
  for (const key of [
    "Document",
    "ShadowRoot",
    "Text",
    "Range",
    "FocusEvent",
    "MouseEvent",
    "KeyboardEvent",
    "InputEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key],
    });
  }

  const spaceState = {
    activeRootId: "root",
    activeRootPath: "/proj",
    activeSpaceId: null,
    rootSpaces: [{ id: "root", path: "/proj", name: "Project" }],
    spaces: [],
    fileTrees: {},
    openSpace: async () => {},
    clearActiveSpace: () => {},
    loadSpaces: async () => {},
  };
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));
  const opened: string[] = [];
  const navigation = { ...(await import("@/features/page/navigation")) };
  mock.module("@/features/page/navigation", () => ({
    ...navigation,
    useOpenPage: () => (path: string) => {
      opened.push(path);
    },
  }));

  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { createPlateEditor, Plate, PlateContent, useEditorRef } =
    await import("platejs/react");
  const { LinkPlugin } = await import("@platejs/link/react");
  const { EditorAssetResolveProvider } =
    await import("../hooks/use-resolved-asset-url");
  const { usePageLinkNavigation } =
    await import("../hooks/use-page-link-navigation");
  const { useInsertPageLinkTarget } =
    await import("../hooks/use-page-link-insertion");
  const { useEditorStore } = await import("../model");
  const { PageLinkElement } = await import("./page-link-element");

  // Pages of the fixture project: what `resolve_doc_link` finds after it
  // decodes the raw url (DF-154A).
  const pages = new Set(["Roadmap Draft.md", "План.md"]);
  let resolveCalls: string[] = [];
  let relativeLink: "backend" | "fails" = "backend";
  function installIpc() {
    resolveCalls = [];
    mockNativeIpc(async (command, args) => {
      if (command === "resolve_doc_link") {
        const { url } = args as { url: string };
        resolveCalls.push(url);
        const path = decodeURIComponent(url.split("#")[0]).replace(
          /^\.\.\//,
          "",
        );
        const exists = pages.has(path);
        return {
          targetSpaceId: null,
          targetSpacePath: "/proj",
          targetPath: path,
          status: exists ? "ready" : "broken",
          exists,
          spaceName: "Project",
        };
      }
      if (command === "make_relative_link") {
        if (relativeLink === "fails") throw new Error("no backend");
        const target = (args as { targetDocPath: string }).targetDocPath;
        return target.replace("/proj/", "../").replaceAll("%", "%25");
      }
      return null;
    });
  }

  const settle = (ms = 30) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await settle(20);
  }
  const context = {
    documentPath: "tasks/Ship.md",
    projectPath: "/proj",
    spaceId: "root",
    spacePath: "/proj",
  };
  const links = [
    "../Roadmap%20Draft.md",
    "../%D0%9F%D0%BB%D0%B0%D0%BD.md",
    "../Nope%20Here.md",
  ];

  function linkEditor() {
    return createPlateEditor({
      plugins: [LinkPlugin.withComponent(PageLinkElement)],
      value: links.map((url, index) => ({
        type: "p",
        children: [
          { text: "" },
          { type: "a", url, children: [{ text: `link ${index}` }] },
          { text: "" },
        ],
      })),
    });
  }
  function Probe({ url }: { url: string }) {
    const link = usePageLinkNavigation(url);
    return (
      <output data-url={url}>
        {`${link.isBroken}|${link.resolvedPath}|${link.tooltipPath}`}
      </output>
    );
  }
  async function render() {
    await dom.render(
      <Plate editor={linkEditor()}>
        <EditorAssetResolveProvider value={context}>
          <PlateContent />
          {links.map((url) => (
            <Probe key={url} url={url} />
          ))}
        </EditorAssetResolveProvider>
      </Plate>,
    );
    await settle();
  }
  function pill(index: number): HTMLElement {
    return [
      ...dom.document.querySelectorAll<HTMLElement>("span.bg-accent"),
    ].find((node) => node.textContent?.includes(`link ${index}`))!;
  }
  function isStruck(index: number): boolean {
    return pill(index).className.includes("line-through");
  }
  function probe(url: string): string {
    return (
      dom.document.querySelector(`output[data-url="${url}"]`)?.textContent ?? ""
    );
  }

  test("only the %-link to a missing file is marked broken", async () => {
    await dom.render(null);
    clearNativeMocks();
    installIpc();
    // Project-mode `validate_links`: decoded paths as written in the document.
    useEditorStore.getState().setBrokenLinks(new Set(["../Nope Here.md"]));
    await render();

    expect(isStruck(0)).toBe(false);
    expect(isStruck(1)).toBe(false);
    expect(isStruck(2)).toBe(true);

    // Space-mode `validate_links`: decoded paths from the Space root.
    await act(async () => {
      useEditorStore.getState().setBrokenLinks(new Set(["Nope Here.md"]));
    });
    expect(isStruck(0)).toBe(false);
    expect(isStruck(2)).toBe(true);
  });

  test("the link hint shows the decoded path", async () => {
    expect(probe(links[0])).toBe(
      "false|Roadmap Draft.md|/proj/Roadmap Draft.md",
    );
    expect(probe(links[1])).toBe("false|План.md|/proj/План.md");
    expect(probe(links[2])).toBe("true|Nope Here.md|/proj/Nope Here.md");
  });

  test("a click resolves the raw url and opens the Page", async () => {
    opened.length = 0;
    await act(async () => {
      pill(0).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await until(() => opened.length > 0);
    expect(resolveCalls).toEqual(["../Roadmap%20Draft.md"]);
    expect(opened).toEqual(["Roadmap Draft.md"]);

    await act(async () => {
      pill(1).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await until(() => opened.length > 1);
    expect(opened).toEqual(["Roadmap Draft.md", "План.md"]);
  });

  test("an inserted link to a Page with % in its title writes %25", async () => {
    const item: SearchItem = {
      id: "root:50% off.md",
      spaceId: null,
      spacePath: "/proj",
      spaceName: "Project",
      path: "50% off.md",
      title: "50% off",
      type: "page",
      tableName: null,
      snippet: null,
      icon: "📄",
    };
    function InsertButton() {
      const insert = useInsertPageLinkTarget(useEditorRef());
      return <button type="button" onClick={() => void insert(item)} />;
    }
    const editor = createPlateEditor({
      value: [{ type: "p", children: [{ text: "" }] }],
    });
    await dom.render(
      <Plate editor={editor}>
        <EditorAssetResolveProvider value={context}>
          <InsertButton />
        </EditorAssetResolveProvider>
      </Plate>,
    );
    const inserted = () =>
      [
        ...editor.api.nodes({
          at: [],
          match: (node) => (node as { type?: string }).type === "a",
        }),
      ].map(([node]) => (node as unknown as { url: string }).url);
    async function insertLink() {
      const count = inserted().length;
      await act(async () => {
        dom.document
          .querySelector("button")!
          .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await until(() => inserted().length > count);
    }

    relativeLink = "backend";
    await insertLink();
    relativeLink = "fails";
    await insertLink();
    expect(inserted()).toEqual(["../50%25 off.md", "../50%25 off.md"]);
  });

  test("teardown", async () => {
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
