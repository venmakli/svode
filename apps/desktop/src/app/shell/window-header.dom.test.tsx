import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import type { ChangesTarget } from "@/features/changes";
import type { OpenWithGroup } from "@/features/external-open";
import type { KnowledgeGraphScreen as GraphScreen } from "@/features/knowledge";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_WINDOW_HEADER_TEST !== "1") {
  test("main top bar order, contributions and Graph", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_WINDOW_HEADER_TEST: "1" },
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
  // Radix decides on layout effects when it loads, so the DOM comes first.
  const dom = await createTestDom();
  const doc = dom.document;
  const spacePath = "/project";
  let selection: unknown = null;

  const realSidebar = await import("@/components/ui/sidebar");
  mock.module("@/components/ui/sidebar", () => ({
    ...realSidebar,
    useSidebar: () => ({ state: "expanded", toggleSidebar() {} }),
  }));
  const realArtifact = await import("@/features/artifact");
  mock.module("@/features/artifact", () => ({
    ...realArtifact,
    useActiveContentSelection: () => ({ selection }),
  }));
  const realSpace = await import("@/features/space");
  const spaceState = {
    activeRootPath: spacePath,
    activeRootName: "Project",
    activeSpaceId: null,
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (select: (state: typeof spaceState) => unknown) =>
      select(spaceState),
    selectActiveSpacePath: () => spacePath,
  }));
  const realSpaceShell = await import("@/features/space/app-shell");
  mock.module("@/features/space/app-shell", () => ({
    ...realSpaceShell,
    MainBreadcrumbs: () => (
      <nav data-slot="breadcrumb" data-part="breadcrumbs" />
    ),
    SpaceBreadcrumbs: ({
      spacePath,
      current,
    }: {
      spacePath: string;
      current: ReactNode;
    }) => (
      <nav
        data-slot="breadcrumb"
        data-part="space-breadcrumbs"
        data-space={spacePath}
      >
        {current}
      </nav>
    ),
  }));
  const realGit = await import("@/features/git/app-shell");
  mock.module("@/features/git/app-shell", () => ({
    ...realGit,
    GitSyncStatusWidget: () => <div data-part="git-sync" />,
  }));
  const realChanges = await import("@/features/changes");
  mock.module("@/features/changes", () => ({
    ...realChanges,
    ChangesControl: ({ target }: { target: ChangesTarget }) => (
      <div data-part="changes" data-scope={target.path} />
    ),
  }));
  const realExternalOpen = await import("@/features/external-open");
  mock.module("@/features/external-open", () => ({
    ...realExternalOpen,
    ProjectExternalOpenButton: ({
      objectGroup,
    }: {
      objectGroup?: OpenWithGroup;
    }) => (
      <div
        data-part="open-with"
        data-object-group={objectGroup?.primary.label ?? ""}
      />
    ),
  }));
  const realSessions = await import("@/features/agent-sessions");
  mock.module("@/features/agent-sessions", () => ({
    ...realSessions,
    useResolvedAgentSession: () => null,
    useAgentSessionSpace: () => null,
    AgentSessionMainSurface: ({
      renderHeader,
    }: {
      renderHeader: (header: {
        spacePath: string;
        current: ReactNode;
        menu: ReactNode;
      }) => ReactNode;
    }) =>
      renderHeader({
        spacePath: "/project/docs",
        current: <span data-part="session-current" />,
        menu: <button type="button" data-part="session-menu" />,
      }),
  }));
  const realKnowledge = await import("@/features/knowledge");
  mock.module("@/features/knowledge", () => ({
    ...realKnowledge,
    KnowledgeGraphScreen: ({
      renderViewTools,
    }: Parameters<typeof GraphScreen>[0]) => (
      <>
        {renderViewTools(
          <>
            <input data-part="graph-search" />
            <button type="button" data-part="graph-scope" />
            <button type="button" data-part="graph-filters" />
            <button type="button" data-part="graph-reset" />
          </>,
        )}
        <div data-graph-canvas />
      </>
    ),
  }));

  // Layout input of the view tools: the width given to the group and the
  // natural width of the tools; the observer reports both on demand.
  let groupWidth = 1000;
  const toolsWidth = 400;
  // Only the view tools group and its tools report resizes here.
  const observers = new Set<() => void>();
  globalThis.ResizeObserver = class {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(target: Element) {
      if (
        target.hasAttribute("data-view-tools") ||
        (target.tagName === "DIV" &&
          target.parentElement?.hasAttribute("data-view-tools"))
      )
        observers.add(this.callback);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  const elementPrototype = doc.defaultView!.HTMLElement.prototype;
  elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = this.hasAttribute("data-view-tools")
      ? groupWidth
      : this.parentElement?.hasAttribute("data-view-tools")
        ? toolsWidth
        : 0;
    return {
      width,
      height: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
    } as DOMRect;
  };
  async function resize(width: number) {
    groupWidth = width;
    await act(async () => {
      observers.forEach((observer) => observer());
    });
  }

  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useShellStore } = await import("./model");
  const { WindowHeader } = await import("./window-header");
  const { PublishMainHeader } = await import("./main-header-contribution");
  const { GraphSurface, SessionSurface } = await import("./main-surfaces");
  const { createDefaultKnowledgeFilters } = realKnowledge;

  function parts() {
    const header = doc.querySelector("header")!;
    return [...header.querySelectorAll<HTMLElement>("[data-part]")].map(
      (element) => element.dataset.part,
    );
  }
  async function render(node: ReactNode) {
    await dom.render(
      <TooltipProvider>
        <WindowHeader />
        {node}
      </TooltipProvider>,
    );
  }
  function changes(path: string, sessionKey: number): ChangesTarget {
    return {
      kind: "owner",
      sourceShape: "directory",
      spacePath,
      projectPath: spacePath,
      sessionKey,
      path,
      name: path,
    };
  }

  test("Space home, Collection, App and Page: Changes stand before Git sync", async () => {
    useShellStore.setState({ mainSurface: "content", mainSessionTarget: null });
    for (const [label, sessionKey, request] of [
      ["space", 1, { kind: "scope", request: { key: 1 } }],
      ["collection", 2, { kind: "scope", request: { key: 2 } }],
      ["app", 3, { kind: "scope", request: { key: 3 } }],
      ["page", 4, { kind: "artifact", request: { sessionKey: 4 } }],
    ] as const) {
      selection = request;
      await render(
        <PublishMainHeader
          changes={changes(`${label}/README.md`, sessionKey)}
        />,
      );
      expect(parts()).toEqual([
        "breadcrumbs",
        "changes",
        "git-sync",
        "open-with",
      ]);
      expect(
        doc.querySelector<HTMLElement>("[data-part=changes]")!.dataset.scope,
      ).toBe(`${label}/README.md`);
      expect(doc.querySelector("[data-view-tools]")).toBeNull();
    }
  });

  test("object actions follow the breadcrumbs and the object group reaches Open with", async () => {
    selection = { kind: "artifact", request: { sessionKey: 5 } };
    const group: OpenWithGroup = {
      primary: { label: "Open in Preview", renderIcon: () => null, run() {} },
      items: null,
      pending: false,
    };
    await render(
      <PublishMainHeader
        changes={changes("doc.pdf", 5)}
        objectActions={<button type="button" data-part="info" />}
        viewTools={<button type="button" data-part="zoom" />}
        openWith={group}
      />,
    );
    expect(parts()).toEqual([
      "breadcrumbs",
      "info",
      "zoom",
      "changes",
      "git-sync",
      "open-with",
    ]);
    expect(
      doc.querySelector<HTMLElement>("[data-part=open-with]")!.dataset
        .objectGroup,
    ).toBe("Open in Preview");

    // The contribution leaves with its surface.
    await render(null);
    expect(parts()).toEqual(["breadcrumbs", "git-sync", "open-with"]);
    expect(
      doc.querySelector<HTMLElement>("[data-part=open-with]")!.dataset
        .objectGroup,
    ).toBe("");
  });

  test("a session puts its Space breadcrumbs, identity and ⋯ first in the row", async () => {
    selection = null;
    const target = { sessionId: "codex:one", launchId: null };
    await act(async () => {
      useShellStore.setState({
        mainSurface: "session",
        mainSessionTarget: target,
      });
    });
    await render(
      <SessionSurface target={target} focus={false} onOpenRoutine={() => {}} />,
    );
    expect(parts().slice(0, 3)).toEqual([
      "space-breadcrumbs",
      "session-current",
      "session-menu",
    ]);
    expect(
      doc.querySelector<HTMLElement>("[data-part=space-breadcrumbs]")!.dataset
        .space,
    ).toBe("/project/docs");
    expect(doc.querySelector("[data-part=breadcrumbs]")).toBeNull();

    // The breadcrumbs leave with the session.
    await act(async () => {
      useShellStore.setState({
        mainSurface: "content",
        mainSessionTarget: null,
      });
    });
    await render(null);
    expect(doc.querySelector("[data-part=space-breadcrumbs]")).toBeNull();
    expect(parts()[0]).toBe("breadcrumbs");
  });

  test("Graph is one row and its tools collapse on a narrow row", async () => {
    selection = null;
    await act(async () => {
      useShellStore.setState({ mainSurface: "graph", mainSessionTarget: null });
    });
    await render(
      <GraphSurface
        openRequest={{
          requestKey: 1,
          query: "",
          scope: { kind: "project" },
          filters: createDefaultKnowledgeFilters(),
          selectedNodeId: null,
        }}
        onActivateContent={() => {}}
      />,
    );
    const crumb = doc.querySelector("header [data-slot=breadcrumb]");
    expect(crumb?.textContent).toBe("Graph");
    expect(crumb?.querySelector("svg") === null).toBe(false);
    expect(parts()).toEqual([
      "graph-search",
      "graph-scope",
      "graph-filters",
      "graph-reset",
      "git-sync",
      "open-with",
    ]);
    const group = doc.querySelector<HTMLElement>("[data-view-tools]")!;
    expect(group.dataset.viewTools).toBe("inline");
    expect(group.style.flexBasis).toBe(`${toolsWidth}px`);

    // Narrower than the tools: one button opens them in a popover.
    await resize(toolsWidth - 1);
    expect(group.dataset.viewTools).toBe("collapsed");
    expect(parts()).toEqual(["git-sync", "open-with"]);
    const toggle = group.querySelector<HTMLButtonElement>(
      'button[aria-label="View tools"]',
    )!;
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const popover = doc.querySelector("[data-slot=popover-content]")!;
    expect(
      [...popover.querySelectorAll<HTMLElement>("[data-part]")].map(
        (element) => element.dataset.part,
      ),
    ).toEqual(["graph-search", "graph-scope", "graph-filters", "graph-reset"]);

    // Wide again: the tools return to the row.
    await resize(toolsWidth + 100);
    expect(group.dataset.viewTools).toBe("inline");
    expect(parts()).toEqual([
      "graph-search",
      "graph-scope",
      "graph-filters",
      "graph-reset",
      "git-sync",
      "open-with",
    ]);
    await dom.dispose();
  });
}
