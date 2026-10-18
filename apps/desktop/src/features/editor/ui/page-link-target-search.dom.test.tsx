import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

if (process.env.SVODE_PAGE_LINK_SEARCH_DOM !== "1") {
  test("page link target search DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_LINK_SEARCH_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  // Slate and Ariakit use these when an editable and a combobox mount.
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

  const treeNode = (path: string, title: string) => ({
    name: path,
    path,
    title,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
  });
  // Ten Pages whose title starts with "Plan" stand before the Page "Plan".
  const childTree = [
    treeNode("Index.md", "Index"),
    ..."ABCDEFGHIJ".split("").map((c) => treeNode(`Plan ${c}.md`, `Plan ${c}`)),
    treeNode("Планёрка.md", "Планёрка"),
    treeNode("Plan.md", "Plan"),
  ];
  const spaceState = {
    activeRootId: "root",
    activeRootPath: "/proj",
    rootSpaces: [{ id: "root", path: "/proj", name: "Project" }],
    spaces: [
      { id: "child", path: "/proj/child", name: "Child" },
      { id: "other", path: "/proj/other", name: "Other" },
    ],
    fileTrees: { child: childTree, other: [treeNode("Plan.md", "Plan")] },
  };
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { createPlateEditor, Plate, PlateContent } =
    await import("platejs/react");
  const { MentionInputPlugin, MentionPlugin } =
    await import("@platejs/mention/react");
  const m = await import("@/paraglide/messages.js");
  const { EditorAssetResolveProvider } =
    await import("../hooks/use-resolved-asset-url");
  const { PageLinkInputElement } = await import("./page-link-input-element");
  const { PageLinkTargetPicker } = await import("./page-link-target-picker");

  type Scope = { kind: "project" } | { kind: "space"; spaceId: string | null };
  interface SearchCall {
    query: string;
    scope: Scope;
  }
  const indexed: Record<string, { path: string; title: string }[]> = {
    root: [
      { path: "План.md", title: "План" },
      { path: "roadmap/q3.md", title: "Q3 goals" },
    ],
    child: childTree.map(({ path, title }) => ({ path, title })),
  };
  let calls: SearchCall[] = [];
  // Queries whose answers wait for release().
  let held = new Set<string>();
  let releases: (() => void)[] = [];

  function item(spaceId: string, entry: { path: string; title: string }) {
    const space =
      spaceId === "root"
        ? spaceState.rootSpaces[0]
        : spaceState.spaces.find((s) => s.id === spaceId)!;
    return {
      id: `${spaceId}:${entry.path}`,
      spaceId: spaceId === "root" ? null : spaceId,
      spacePath: space.path,
      spaceName: space.name,
      path: entry.path,
      title: entry.title,
      type: "page",
      tableName: null,
      snippet: null,
      icon: "📄",
    };
  }
  // A stand-in for the index: case-insensitive match on title or path, a
  // ticket-like id hit for "TCK-1", and no ranking of its own.
  function search({ query, scope }: SearchCall) {
    const spaceIds =
      scope.kind === "project"
        ? Object.keys(indexed)
        : [scope.spaceId ?? "root"];
    const q = query.toLowerCase();
    return spaceIds.flatMap((spaceId) =>
      (indexed[spaceId] ?? [])
        .filter(
          ({ path, title }) =>
            title.toLowerCase().includes(q) ||
            path.toLowerCase().includes(q) ||
            (query === "TCK-1" && title === "Q3 goals"),
        )
        .slice(0, 8)
        .map((entry) => item(spaceId, entry)),
    );
  }
  function installIpc() {
    calls = [];
    held = new Set();
    releases = [];
    mockNativeIpc(async (command, args) => {
      if (command === "make_relative_link") {
        const target = (args as { targetDocPath: string }).targetDocPath;
        return target.replace("/proj/child/", "");
      }
      if (command !== "search_project_pages_by_title") return null;
      const call = args as unknown as SearchCall;
      calls.push({ query: call.query, scope: call.scope });
      if (held.has(call.query)) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      const items = search(call);
      return { items, indexedSpaces: 2, totalSpaces: 3 };
    });
  }

  const settle = (ms = 30) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  async function release() {
    const pending = releases;
    releases = [];
    held = new Set();
    for (const resolve of pending) resolve();
    await settle();
  }
  async function until(check: () => boolean) {
    for (let i = 0; i < 250 && !check(); i++) await settle(20);
  }
  function context(spaceId: string) {
    return {
      documentPath: "Index.md",
      projectPath: "/proj",
      spaceId,
      spacePath: spaceId === "root" ? "/proj" : `/proj/${spaceId}`,
    };
  }
  function mentionEditor() {
    return createPlateEditor({
      plugins: [
        MentionPlugin,
        MentionInputPlugin.withComponent(PageLinkInputElement),
      ],
      value: [
        {
          type: "p",
          children: [
            { text: "" },
            { type: "mention_input", trigger: "@", children: [{ text: "" }] },
            { text: "" },
          ],
        },
      ],
    });
  }
  async function renderMention(spaceId: string) {
    const editor = mentionEditor();
    await dom.render(
      <Plate editor={editor}>
        <EditorAssetResolveProvider value={context(spaceId)}>
          <PlateContent />
        </EditorAssetResolveProvider>
      </Plate>,
    );
    await settle();
    return editor;
  }
  async function renderPicker(spaceId: string) {
    await dom.render(
      <Plate editor={createPlateEditor()}>
        <EditorAssetResolveProvider value={context(spaceId)}>
          <PageLinkTargetPicker />
        </EditorAssetResolveProvider>
      </Plate>,
    );
    await settle();
  }
  function input(): HTMLInputElement {
    return dom.document.querySelector("input")!;
  }
  async function type(value: string) {
    const field = input();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await settle();
  }
  function titles(): string[] {
    return [...dom.document.querySelectorAll('[role="option"]')].map(
      (option) => option.querySelector(".font-medium")?.textContent ?? "",
    );
  }
  function listText(): string {
    return dom.document.body.textContent ?? "";
  }
  async function reset() {
    await dom.render(null);
    clearNativeMocks();
    installIpc();
  }

  test("the @ list searches the typed text and ranks the exact title first", async () => {
    await reset();
    await renderMention("child");
    await until(() => titles().length > 0);
    expect(calls.map((c) => c.query)).toEqual(["", ""]);
    expect(titles()).toEqual([
      "Index",
      "Plan A",
      "Plan B",
      "Plan C",
      "Plan D",
      "Plan E",
      "Plan F",
      "Plan G",
    ]);

    await type("Plan");
    await until(() => titles()[0] === "Plan");
    expect(calls.at(-1)?.query).toBe("Plan");
    expect(titles()[0]).toBe("Plan");
    expect(titles().length).toBe(8);

    await type("ПЛАН");
    await until(() => titles()[0] === "План");
    expect(titles().slice(0, 2)).toEqual(["План", "Планёрка"]);

    // Found by the index inside the path or by an id: the combobox filter
    // does not hide them.
    await type("map");
    await until(() => titles().length === 1);
    expect(titles()).toEqual(["Q3 goals"]);
    await type("TCK-1");
    await until(() => calls.at(-1)?.query === "TCK-1");
    await settle();
    expect(titles()).toEqual(["Q3 goals"]);
  });

  test("the @ list keeps loading instead of no results and drops stale answers", async () => {
    await reset();
    held = new Set([""]);
    await renderMention("child");
    expect(titles()).toEqual([]);
    expect(listText().includes(m.common_loading())).toBe(true);
    expect(listText().includes(m.editor_page_link_no_results())).toBe(false);
    await release();
    await until(() => titles().length > 0);
    expect(titles()[0]).toBe("Index");

    held = new Set(["Pl"]);
    await type("Pl");
    await type("Plan");
    await until(() => titles()[0] === "Plan");
    expect(calls.some((c) => c.query === "Pl")).toBe(true);
    await release();
    await settle();
    expect(titles()[0]).toBe("Plan");

    held = new Set(["zzz"]);
    await type("zzz");
    expect(titles()[0]).toBe("Plan");
    expect(listText().includes(m.editor_page_link_no_results())).toBe(false);
    await release();
    await until(() => titles().length === 0);
    expect(titles()).toEqual([]);
    expect(listText().includes(m.editor_page_link_no_results())).toBe(true);
  });

  test("a child Space searches itself and root, root searches the project", async () => {
    await reset();
    await renderMention("child");
    await type("Plan");
    await until(() => calls.filter((c) => c.query === "Plan").length === 2);
    expect(new Set(calls.map((c) => JSON.stringify(c.scope)))).toEqual(
      new Set([
        JSON.stringify({ kind: "space", spaceId: "child" }),
        JSON.stringify({ kind: "space", spaceId: null }),
      ]),
    );

    await reset();
    await renderMention("root");
    await type("Plan");
    await until(() => calls.some((c) => c.query === "Plan"));
    expect(new Set(calls.map((c) => JSON.stringify(c.scope)))).toEqual(
      new Set([JSON.stringify({ kind: "project" })]),
    );
  });

  test("choosing a candidate inserts the same link as before", async () => {
    await reset();
    const editor = await renderMention("child");
    // Slate cannot move the DOM selection in JSDOM, so the link lands at the
    // end of the document instead of the caret.
    editor.tf.focus = () => {};
    await type("Plan");
    await until(() => titles()[0] === "Plan");
    const option = dom.document.querySelector('[role="option"]')!;
    await act(async () => {
      option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    const links = () => [
      ...editor.api.nodes({
        at: [],
        match: (node) => (node as { type?: string }).type === "a",
      }),
    ];
    await until(() => links().length > 0);
    expect(links().map(([node]) => node)).toEqual([
      { type: "a", url: "Plan.md", children: [{ text: "Plan" }] },
    ]);
  });

  test("the link toolbar picker ranks the exact title first", async () => {
    await reset();
    await renderPicker("child");
    await until(() => titles().length > 0);
    await type("Plan");
    await until(() => titles()[0] === "Plan");
    expect(calls.at(-1)?.query).toBe("Plan");
    expect(titles()[0]).toBe("Plan");
    await type("план");
    await until(() => titles()[0] === "План");
    expect(titles()[0]).toBe("План");
  });

  test("teardown", async () => {
    await reset();
    clearNativeMocks();
    await dom.dispose();
  });
}
