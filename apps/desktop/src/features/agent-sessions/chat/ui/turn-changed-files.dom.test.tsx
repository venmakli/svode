import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TURN_CHANGED_FILES_DOM !== "1") {
  test("turn changed files DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TURN_CHANGED_FILES_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");

  const key: AgentSessionKeyDto = {
    agent: "claude-code",
    namespace: "native",
    sessionId: "s1",
  };
  const details: string[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (command === "agent_runtime_detail") {
      const itemId = payload.itemId as string;
      details.push(itemId);
      return {
        outcome: "available",
        blocks: [
          {
            type: "diff",
            path: "/project/a.md",
            oldText: `before ${itemId}`,
            newText: `after ${itemId}`,
          },
          {
            type: "diff",
            path: "/project/other.md",
            oldText: null,
            newText: "x",
          },
        ],
      };
    }
    if (command === "git_status") {
      return {
        branch: "main",
        ahead: 0,
        behind: 0,
        hasStaged: false,
        hasUnstaged: true,
        hasConflicts: false,
        tracking: null,
        files: [{ path: "a.md", state: "modified" }],
      };
    }
    if (command === "path_exists") return payload.path !== "/project/old.md";
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { ChatTimeline } = await import("./chat-timeline");
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");
  const { ChangesOpenerContext } = await import("../hooks/use-changes-opener");

  const { registerRootSpace } = await import("@/features/space");
  registerRootSpace({ id: "root", name: "Project", path: "/project" } as never);

  const opened: { kind: string; path: string }[] = [];

  function item(
    id: string,
    turnId: string,
    kind: Record<string, unknown>,
    summary = "",
  ): AgentActivityItemDto {
    return {
      id,
      turnId,
      status: "completed",
      summary,
      hasDetail: kind.kind === "tool_call",
      ...(kind.kind === "tool_call" || kind.kind === "agent_message"
        ? { media: [] }
        : {}),
      ...kind,
    } as AgentActivityItemDto;
  }

  const edit = (id: string, turnId: string, added: number) =>
    item(
      id,
      turnId,
      {
        kind: "tool_call",
        tool: "edit",
        locations: [
          {
            path: "/project/a.md",
            change: "modified",
            lines: { added, removed: 1 },
          },
        ],
        mcpCalls: [],
      },
      `Edit a.md ${id}`,
    );

  function snapshot(): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: "t3",
        phase: "running",
        lastOutcome: null,
        status: {
          state: "running",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [
        item("user:t1", "t1", { kind: "user_message", segments: [] }, "Edit"),
        edit("e1", "t1", 2),
        item(
          "mcp1",
          "t1",
          {
            kind: "tool_call",
            tool: "other",
            locations: [
              { path: "/project/notes/B.md", change: "created", lines: null },
            ],
            mcpCalls: [
              {
                server: "plugin_svode_svode",
                tool: "create_page",
                changesProject: true,
              },
            ],
          },
          "mcp__plugin_svode_svode__create_page",
        ),
        edit("e2", "t1", 1),
        item(
          "rm",
          "t1",
          {
            kind: "tool_call",
            tool: "delete",
            locations: [
              { path: "/project/old.md", change: "deleted", lines: null },
            ],
            mcpCalls: [],
          },
          "Delete old.md",
        ),
        item("m1", "t1", { kind: "agent_message" }, "All edited"),
        item("outcome:t1", "t1", {
          kind: "turn_outcome",
          reason: "end_turn",
          durationMs: 3000,
        }),
        item("user:t2", "t2", { kind: "user_message", segments: [] }, "Read"),
        item(
          "r1",
          "t2",
          {
            kind: "tool_call",
            tool: "read",
            locations: [{ path: "/project/a.md", change: null, lines: null }],
            mcpCalls: [],
          },
          "Read a.md",
        ),
        item("m2", "t2", { kind: "agent_message" }, "Read it"),
        item("outcome:t2", "t2", {
          kind: "turn_outcome",
          reason: "end_turn",
          durationMs: 1000,
        }),
        item("user:t3", "t3", { kind: "user_message", segments: [] }, "More"),
        edit("e3", "t3", 4),
      ],
      pending: null,
      history: { source: "live", available: true, truncatedItems: null },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    } as unknown as AgentSessionSnapshotDto;
  }

  const mounted: Root[] = [];
  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <AttachmentOpenerContext.Provider
              value={(attachment) =>
                opened.push({ kind: "document", path: attachment.path })
              }
            >
              <ChangesOpenerContext.Provider
                value={(target) =>
                  opened.push({
                    kind: "changes",
                    path: `${target.spacePath}|${target.path}|${target.name}`,
                  })
                }
              >
                <ChatTimeline session={key} snapshot={snapshot()} />
              </ChangesOpenerContext.Provider>
            </AttachmentOpenerContext.Provider>
          </TooltipProvider>
        </ThemeProvider>,
      );
    });
    await settle();
  }

  function filesRows() {
    return Array.from(document.querySelectorAll("button")).filter((element) =>
      element.textContent?.includes(
        m.sessions_chat_changed_files({ count: 3 }),
      ),
    );
  }

  function buttonByLabel(label: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.getAttribute("aria-label") === label,
    );
  }

  function buttonByText(text: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === text,
    );
  }

  test("a folded finished turn shows its changed files once under the last message", async () => {
    try {
      await mount();
      const rows = filesRows();
      // Only the first turn: the second changed nothing, the third runs.
      expect(rows?.length).toBe(1);
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_changed_files({ count: 1 }),
        ),
      ).toBe(false);
      // The turn is folded: its tool rows are hidden, the files row is not.
      expect(document.body.textContent?.includes("Edit a.md e1")).toBe(false);
      const message = Array.from(document.querySelectorAll("p")).find(
        (element) => element.textContent === "All edited",
      );
      expect(
        Boolean(
          message!.compareDocumentPosition(rows[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(rows[0].textContent?.includes("+3")).toBe(true);
      expect(rows[0].textContent?.includes("−2")).toBe(true);

      await click(rows[0]);
      await settle();
      // A file with a diff unfolds it; a file without one does not.
      const diffToggle = buttonByLabel(
        m.sessions_chat_changed_file_diff({ name: "a.md" }),
      );
      expect(Boolean(diffToggle)).toBe(true);
      expect(
        buttonByLabel(m.sessions_chat_changed_file_diff({ name: "B.md" })),
      ).toBe(undefined);

      const created = buttonByText("B.md")!.closest("li")!;
      expect(created.textContent?.includes("+")).toBe(false);
      await click(diffToggle);
      await settle();
      expect(details).toEqual(["e1", "e2"]);
      const headers = Array.from(document.querySelectorAll("div")).filter(
        (element) =>
          element.className.includes("font-mono") &&
          element.textContent === "/project/a.md",
      );
      expect(headers?.length).toBe(2);
      expect(document.body.textContent?.includes("/project/other.md")).toBe(
        false,
      );

      // A file with unsaved changes opens the Changes window, a saved one
      // its document, a deleted one nothing.
      await click(buttonByText("a.md"));
      await click(buttonByText("B.md"));
      const removed = buttonByText("old.md");
      expect(removed?.getAttribute("aria-disabled")).toBe("true");
      await click(removed);
      expect(opened).toEqual([
        { kind: "changes", path: "/project|a.md|a.md" },
        { kind: "document", path: "/project/notes/B.md" },
      ]);
    } finally {
      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
    }
  });

  async function click(element: Element | undefined) {
    if (!element) throw new Error("nothing to click");
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    // The diff renderer defines its element when it loads.
    customElements: dom.window.customElements,
    CSSStyleSheet: dom.window.CSSStyleSheet,
    DOMRect: dom.window.DOMRect,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
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
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
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
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
