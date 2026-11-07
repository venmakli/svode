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

  const openedSpaces: string[] = [];
  // The link popover measures the selection; jsdom ranges have no layout.
  const emptyRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  Object.assign(window.Range.prototype, {
    getBoundingClientRect: emptyRect,
    getClientRects: () => [],
  });

  const spaceState = {
    activeRootId: "root",
    activeRootPath: "/proj",
    activeSpaceId: null,
    rootSpaces: [{ id: "root", path: "/proj", name: "Project" }],
    spaces: [],
    fileTrees: {},
    openSpace: async (id: string) => {
      openedSpaces.push(id);
    },
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

  // The neutral opening of an artifact (DF-317).
  const openedArtifacts: { path: string; spaceId?: string | null }[] = [];
  const artifact = { ...(await import("@/features/artifact")) };
  mock.module("@/features/artifact", () => ({
    ...artifact,
    useOpenArtifact:
      () => (target: { path: string; spaceId?: string | null }) => {
        openedArtifacts.push(target);
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
  const { BrokenLinksPlugin } = await import("../plate/broken-links-plugin");
  const { PageLinkElement } = await import("./page-link-element");
  const { PageLinkFloatingToolbar } = await import("./page-link-toolbar");
  const { isMacKeyboardPlatform } =
    await import("@/shared/lib/keyboard-shortcuts");
  const { InlineImagePlugin } = await import("../plate/inline-image-plugin");

  // Pages of the fixture project: what `resolve_doc_link` finds after it
  // decodes the raw url (DF-154A).
  const pages = new Set(["Roadmap Draft.md", "План.md"]);
  // Other files of the fixture project, by the path from the project root.
  const files = new Set(["reports/dashboard.html", "team/board.html"]);
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
        if (path.startsWith("team/") || path.startsWith("cold/")) {
          const [folder, ...rest] = path.split("/");
          return {
            targetSpaceId: folder,
            targetSpacePath: `/proj/${folder}`,
            targetPath: rest.join("/"),
            status: folder === "cold" ? "missing" : "ready",
            exists: files.has(path),
            spaceName: folder,
          };
        }
        if (path.startsWith("../")) {
          return {
            targetSpaceId: null,
            targetSpacePath: null,
            targetPath: null,
            status: "broken",
            exists: false,
            spaceName: "",
          };
        }
        if (/\.(html|pdf)$/.test(path)) {
          return {
            targetSpaceId: null,
            targetSpacePath: "/proj",
            targetPath: path,
            status: "ready",
            exists: files.has(path),
            spaceName: "Project",
          };
        }
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
      plugins: [
        LinkPlugin.withComponent(PageLinkElement),
        InlineImagePlugin,
        BrokenLinksPlugin,
      ],
      value: [
        ...links.map((url, index) => ({
          type: "p",
          children: [
            { text: "" },
            { type: "a", url, children: [{ text: `link ${index}` }] },
            { text: "" },
          ],
        })),
        {
          type: "p",
          children: [
            { text: "" },
            {
              type: "a",
              url: links[1],
              children: [
                { text: "" },
                {
                  type: "inline_img",
                  url: "logo.png",
                  alt: "logo",
                  children: [{ text: "" }],
                },
                { text: "" },
              ],
            },
            { text: "" },
          ],
        },
      ],
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
  async function render(editor = linkEditor()) {
    await dom.render(
      <Plate editor={editor}>
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
    const editor = linkEditor();
    editor.setOption(
      BrokenLinksPlugin,
      "brokenLinks",
      new Set(["../Nope Here.md"]),
    );
    await render(editor);

    expect(isStruck(0)).toBe(false);
    expect(isStruck(1)).toBe(false);
    expect(isStruck(2)).toBe(true);

    // Space-mode `validate_links`: decoded paths from the Space root.
    await act(async () => {
      editor.setOption(
        BrokenLinksPlugin,
        "brokenLinks",
        new Set(["Nope Here.md"]),
      );
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

  test("hovering a link opens its hint with the decoded path", async () => {
    const text = pill(0).querySelector("[data-slate-string]") ?? pill(0);
    const move = new window.MouseEvent("pointermove", { bubbles: true });
    Object.defineProperty(move, "pointerType", { value: "mouse" });
    await act(async () => {
      text.dispatchEvent(move);
    });
    await until(() => dom.document.querySelector('[role="tooltip"]') !== null);
    expect(dom.document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "/proj/Roadmap Draft.md",
    );
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

  test("a click on an image inside the pill opens the Page", async () => {
    opened.length = 0;
    const image = dom.document.querySelector<HTMLElement>(
      'span.bg-accent img[alt="logo"]',
    )!;
    await act(async () => {
      image.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await until(() => opened.length > 0);
    expect(opened).toEqual(["План.md"]);
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

  // DF-317: a link to a project file that is not a Page.
  const fileContext = { ...context, documentPath: "notes/links.md" };
  const fileLinks = [
    "../reports/dashboard.html",
    "../team/board.html",
    "../reports/gone.html",
    "../../outside.html",
    "../cold/plan.pdf",
    "https://example.com/report",
  ];
  function fileLinkEditor(selectedLink?: number) {
    const editor = createPlateEditor({
      plugins: [
        LinkPlugin.configure({
          render: {
            node: PageLinkElement,
            afterEditable: () => <PageLinkFloatingToolbar />,
          },
        }),
        BrokenLinksPlugin,
      ],
      value: fileLinks.map((url, index) => ({
        type: "p",
        children: [
          { text: "" },
          { type: "a", url, children: [{ text: `file ${index}` }] },
          { text: "" },
        ],
      })),
    });
    if (selectedLink !== undefined) {
      editor.tf.select({ path: [selectedLink, 1, 0], offset: 2 });
    }
    return editor;
  }
  async function renderFileLinks(selectedLink?: number) {
    await dom.render(null);
    await dom.render(
      <Plate editor={fileLinkEditor(selectedLink)}>
        <EditorAssetResolveProvider value={fileContext}>
          <PlateContent />
        </EditorAssetResolveProvider>
      </Plate>,
    );
    await settle();
  }
  function fileLink(index: number): HTMLAnchorElement {
    return [...dom.document.querySelectorAll<HTMLAnchorElement>("a")].find(
      (node) => node.textContent?.includes(`file ${index}`),
    )!;
  }
  function click(target: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }
  const openModifier: MouseEventInit = isMacKeyboardPlatform()
    ? { metaKey: true }
    : { ctrlKey: true };
  function resetOpened() {
    openedArtifacts.length = 0;
    openedSpaces.length = 0;
    opened.length = 0;
    resolveCalls = [];
  }

  test("a file link stays underlined text, without the Page pill", async () => {
    clearNativeMocks();
    installIpc();
    await renderFileLinks();
    const link = fileLink(0);
    expect(link.tagName).toBe("A");
    expect(link.className.includes("underline")).toBe(true);
    expect(link.querySelector("svg")).toBeNull();
    expect(dom.document.querySelectorAll("span.bg-accent").length).toBe(0);
  });

  test("a ⌘-click opens the resolved file with the neutral opening", async () => {
    resetOpened();
    let windowOpens = 0;
    window.open = () => {
      windowOpens += 1;
      return null;
    };
    let event!: MouseEvent;
    await act(async () => {
      event = click(fileLink(0), openModifier);
    });
    await until(() => openedArtifacts.length > 0);
    expect(event.defaultPrevented).toBe(true);
    expect(resolveCalls).toEqual(["../reports/dashboard.html"]);
    expect(openedArtifacts).toEqual([
      { path: "reports/dashboard.html", spaceId: "root", sourceShape: "file" },
    ]);
    expect(opened).toEqual([]);
    expect(windowOpens).toBe(0);
  });

  test("a file in another Space opens in that Space", async () => {
    resetOpened();
    await act(async () => {
      click(fileLink(1), openModifier);
    });
    await until(() => openedArtifacts.length > 0);
    expect(openedSpaces).toEqual(["team"]);
    expect(openedArtifacts).toEqual([
      { path: "board.html", spaceId: "team", sourceShape: "file" },
    ]);
  });

  test("a missing file opens its viewer, which shows it is not found", async () => {
    resetOpened();
    await act(async () => {
      click(fileLink(2), openModifier);
    });
    await until(() => openedArtifacts.length > 0);
    expect(openedArtifacts).toEqual([
      { path: "reports/gone.html", spaceId: "root", sourceShape: "file" },
    ]);
  });

  test("a link outside the project opens nothing", async () => {
    resetOpened();
    let event!: MouseEvent;
    await act(async () => {
      event = click(fileLink(3), openModifier);
    });
    await until(() => resolveCalls.length > 0);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(openedArtifacts).toEqual([]);
  });

  test("a file in a missing Space asks to clone it", async () => {
    resetOpened();
    await act(async () => {
      click(fileLink(4), openModifier);
    });
    const dialog = () =>
      dom.document.querySelector('[role="alertdialog"]') !== null;
    await until(dialog);
    expect(dialog()).toBe(true);
    expect(openedArtifacts).toEqual([]);
  });

  test("a plain click and an external link keep their behavior", async () => {
    await renderFileLinks();
    resetOpened();
    let plain!: MouseEvent;
    let external!: MouseEvent;
    await act(async () => {
      plain = click(fileLink(0));
      external = click(fileLink(5), openModifier);
    });
    await settle();
    expect(plain.defaultPrevented).toBe(false);
    expect(external.defaultPrevented).toBe(false);
    expect(fileLink(5).getAttribute("href")).toBe("https://example.com/report");
    expect(resolveCalls).toEqual([]);
    expect(openedArtifacts).toEqual([]);
  });

  test("the open button of the link popover opens the file", async () => {
    await renderFileLinks(0);
    resetOpened();
    const button = await (async () => {
      const find = () =>
        dom.document.querySelector<HTMLElement>(
          'button[aria-label="Open link"]',
        );
      await until(() => find() !== null);
      return find()!;
    })();
    await act(async () => {
      click(button);
    });
    await until(() => openedArtifacts.length > 0);
    expect(openedArtifacts).toEqual([
      { path: "reports/dashboard.html", spaceId: "root", sourceShape: "file" },
    ]);
  });

  test("the open button of an external link stays a browser link", async () => {
    await renderFileLinks(5);
    const find = () =>
      dom.document.querySelector<HTMLElement>('a[aria-label="Open link"]');
    await until(() => find() !== null);
    expect(find()!.getAttribute("href")).toBe("https://example.com/report");
    expect(find()!.getAttribute("target")).toBe("_blank");
  });

  test("teardown", async () => {
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
