import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_SCOPE_ITEM_MAIN_DOM !== "1") {
  test("scope item main DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SCOPE_ITEM_MAIN_DOM: "1" },
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
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const calls = {
    opened: [] as unknown[][],
    closed: 0,
    forgotten: [] as unknown[],
    guards: [] as Array<() => unknown>,
  };
  let allow = true;
  const realArtifact = await import("@/features/artifact");
  mock.module("@/features/artifact", () => ({
    ...realArtifact,
    closeActiveContent: () => {
      calls.closed++;
    },
    openScopeOwner: (...args: unknown[]) => calls.opened.push(args),
    registerSupplementalContentDeactivation: (guard: () => unknown) => {
      calls.guards.push(guard);
      return () => calls.guards.splice(calls.guards.indexOf(guard), 1);
    },
  }));
  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => allow,
  }));
  const realNavigation = await import("@/features/navigation");
  mock.module("@/features/navigation", () => ({
    ...realNavigation,
    getNavigationState: () => ({
      forget: async (keys: unknown[]) => {
        calls.forgotten.push(...keys);
      },
    }),
  }));
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector: (state: { activeRootId: string }) => unknown) =>
      selector({ activeRootId: "root" }),
  }));
  /** The breadcrumbs as data: the owner, its links, the current element. */
  mock.module("@/features/space/app-shell", () => ({
    SpaceBreadcrumbs: ({
      spacePath,
      path,
      links,
      current,
    }: {
      spacePath: string;
      path: string | null;
      links: { key: string; label: string; onOpen(): void }[];
      current: ReactNode;
    }) => (
      <nav data-crumbs={`${spacePath}|${path ?? ""}`}>
        {links.map((link) => (
          <button key={link.key} type="button" onClick={link.onOpen}>
            {link.label}
          </button>
        ))}
        <span data-current>{current}</span>
      </nav>
    ),
  }));
  mock.module("./main-header-contribution", () => ({
    PublishMainHeader: ({
      breadcrumbs,
      objectActions,
      viewTools,
    }: {
      breadcrumbs: ReactNode;
      objectActions?: ReactNode;
      viewTools?: ReactNode;
    }) => (
      <header data-main-header>
        {breadcrumbs}
        {objectActions}
        {viewTools}
      </header>
    ),
  }));
  mock.module("./model", () => {
    const shell = { openContentSurface: () => undefined };
    const useShellStore = (selector: (state: typeof shell) => unknown) =>
      selector(shell);
    return { useShellStore };
  });

  const { CollectionItemMain } =
    await import("@/features/collection/app-shell");
  const { ScopeItemMain } = await import("./scope-item-main");
  const { ListChecks } = await import("lucide-react");
  type Contribution = Parameters<typeof ScopeItemMain>[0]["surface"];
  type Owner = Parameters<typeof ScopeItemMain>[0]["owner"];

  const owner: Owner = {
    ownerKey: "space:child",
    identityKind: "registered-space",
    spaceId: "child",
    spacePath: "/project/child",
    projectPath: "/project",
    ownerPath: ".",
    readmePath: "README.md",
    capabilities: ["space"],
  };
  const source: { set?: (items: string[] | null) => void } = {};
  function Routines({
    mainItem,
    onExpandItem,
  }: Parameters<NonNullable<Contribution>["render"]>[0]) {
    const [items, setItems] = useState<string[] | null>(["daily"]);
    useEffect(() => {
      source.set = setItems;
    }, []);
    if (!mainItem) return null;
    return (
      <>
        <CollectionItemMain
          main={mainItem}
          target={mainItem.item.itemId}
          find={(id: string) =>
            items ? items.find((item) => item === id) : null
          }
          render={(item: string) => ({
            content: <p>{item}</p>,
            identity: { icon: <span>◷</span>, name: "Daily" },
            menu: <button type="button">Actions</button>,
          })}
        />
        <button
          type="button"
          data-expand
          onClick={() =>
            onExpandItem?.({ surfaceId: "routines", itemId: "weekly" })
          }
        />
      </>
    );
  }
  const surface: Contribution = {
    id: "routines",
    order: 0,
    presentations: ["full"],
    appliesTo: () => true,
    label: "Routines",
    icon: ListChecks,
    render: (context) => <Routines {...context} />,
  };
  const routineKey = {
    kind: "routine",
    spaceId: "child",
    ownerKind: "space",
    ownerPath: ".",
    routineId: "daily",
  };
  const displayed: Record<string, string> = {};
  function Displays() {
    const display = realNavigation.useNavigationItemDisplay(
      realNavigation.navigationKeyId(routineKey as never),
    );
    if (display)
      displayed[realNavigation.navigationKeyId(routineKey as never)] =
        display.title;
    return null;
  }
  const displays = () => displayed;
  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  test("the top bar shows the owner, the tab and the item; the tab opens the owner on it", async () => {
    await act(async () =>
      root.render(
        <>
          <ScopeItemMain
            owner={owner}
            item={{ surfaceId: "routines", itemId: "daily" }}
            surface={surface}
          />
          <Displays />
        </>,
      ),
    );
    const header = document.querySelector("[data-main-header]")!;
    expect(header.querySelector("nav")?.getAttribute("data-crumbs")).toBe(
      "/project/child|",
    );
    expect(header.querySelector("[data-current]")?.textContent).toBe("◷Daily");
    expect(header.textContent?.includes("Actions")).toBe(true);
    // The row in Now takes the item's name from its screen.
    expect(
      displays()[realNavigation.navigationKeyId(routineKey as never)],
    ).toBe("Daily");

    allow = false;
    await act(async () => header.querySelector("button")!.click());
    await settle();
    expect(calls.opened).toEqual([]);
    allow = true;
    await act(async () => header.querySelector("button")!.click());
    await settle();
    expect(calls.opened).toEqual([
      [
        { kind: "space", spaceId: "child" },
        { scopeOpenIntent: { kind: "target", surfaceId: "routines" } },
      ],
    ]);
  });

  test("Expand of another item opens it over the same owner past the guards", async () => {
    calls.opened = [];
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-expand]")!.click(),
    );
    await settle();
    expect(calls.opened).toEqual([
      [
        { kind: "space", spaceId: "child" },
        {
          scopeOpenIntent: {
            kind: "item",
            item: { surfaceId: "routines", itemId: "weekly" },
          },
        },
      ],
    ]);
  });

  test("an item the ready source no longer has leaves navigation and the main area", async () => {
    await act(async () => source.set!([]));
    await settle();
    expect(calls.forgotten).toEqual([routineKey]);
    expect(calls.closed).toBe(1);
    await act(async () => root.render(null));
  });
}
