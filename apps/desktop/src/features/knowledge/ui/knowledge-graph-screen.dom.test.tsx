import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_KNOWLEDGE_SCREEN_TEST !== "1") {
  test("Graph hands its tools to the host top bar", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_KNOWLEDGE_SCREEN_TEST: "1" },
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
  const queries: string[] = [];
  const resetKeys: number[] = [];
  mock.module("../hooks/use-knowledge-snapshot", () => ({
    useKnowledgeSnapshot: (_path: string, _scope: unknown, query: string) => {
      queries.push(query);
      return {
        snapshot: null,
        loading: false,
        error: null,
        mode: "complete",
        projectionKey: "",
        retry() {},
        async repair() {},
        repairing: false,
        repairError: null,
      };
    },
  }));
  // The panel layout needs real geometry; the test needs only its children.
  mock.module("@/components/ui/resizable", () => ({
    ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    ResizablePanel: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    ResizableHandle: () => null,
  }));
  mock.module("../hooks/use-knowledge-neighbors", () => ({
    useKnowledgeNeighbors: () => ({ edges: [], loading: false, error: null }),
  }));
  mock.module("./knowledge-graph-view", () => ({
    KnowledgeGraphView: ({ resetKey }: { resetKey: number }) => {
      resetKeys.push(resetKey);
      return <div data-graph-view />;
    },
  }));

  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { KnowledgeGraphScreen } = await import("./knowledge-graph-screen");
  const m = await import("@/paraglide/messages.js");
  const topBar = doc.createElement("div");
  doc.body.append(topBar);

  test("the screen has no own header row; search, scope, filters and reset work from the top bar", async () => {
    await dom.render(
      <TooltipProvider>
        <KnowledgeGraphScreen
          projectPath="/project"
          spaces={[{ id: null, name: "Project" }]}
          openRequest={null}
          onOpenSource={() => {}}
          renderViewTools={(tools) => createPortal(tools, topBar)}
        />
      </TooltipProvider>,
    );
    const screen = doc.getElementById("app")!;
    expect(screen.querySelector("header")).toBeNull();
    expect(screen.querySelector("h1")).toBeNull();
    expect(screen.querySelector("[data-graph-view]") === null).toBe(false);

    const search = topBar.querySelector<HTMLInputElement>("input")!;
    expect(search.placeholder).toBe(m.search_placeholder());
    const reset = topBar.querySelector<HTMLButtonElement>(
      `[aria-label="${m.knowledge_graph_reset()}"]`,
    )!;
    expect(
      [...topBar.querySelectorAll("input, button")].map(
        (element) =>
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder"),
      ),
    ).toEqual([
      m.search_placeholder(),
      m.knowledge_graph_space_filter(),
      m.knowledge_graph_filters(),
      m.knowledge_graph_reset(),
    ]);

    // The query typed in the top bar drives the Graph as before.
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        doc.defaultView!.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(search, "roadmap");
      search.dispatchEvent(
        new doc.defaultView!.Event("input", { bubbles: true }),
      );
    });
    expect(queries.at(-1)).toBe("roadmap");
    expect(search.value).toBe("roadmap");

    const before = resetKeys.at(-1)!;
    await act(async () => {
      reset.click();
    });
    expect(resetKeys.at(-1)).toBe(before + 1);
    await dom.dispose();
  });
}
