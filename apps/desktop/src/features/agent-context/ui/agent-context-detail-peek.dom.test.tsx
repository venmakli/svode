import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  CollectionDetailContent,
  CollectionDetailController,
} from "@/features/collection/app-shell";

import type { AgentContextItem } from "../model/types";

if (process.env.SVODE_AGENT_CONTEXT_PEEK_DOM !== "1") {
  test("agent context detail peek DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_CONTEXT_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    SVGElement: dom.window.SVGElement,
    DOMRect: dom.window.DOMRect,
    FocusEvent: dom.window.FocusEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
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
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const instruction: AgentContextItem = {
    body: "# Project instructions",
    description: null,
    health: "normal",
    healthReasons: [],
    id: "instruction:/workspace/AGENTS.md",
    kind: "instruction",
    location: { kind: "target", path: "" },
    modifiedAt: "2026-10-15T08:00:00Z",
    name: "AGENTS.md",
    ownerPath: "/workspace",
    path: "/workspace/AGENTS.md",
    providers: ["codex"],
    references: [],
    skill: null,
    sources: [
      {
        path: "/workspace/AGENTS.md",
        readers: [{ agent: "codex", supersededBy: null }],
        target: null,
      },
    ],
    truncated: false,
    unapplied: null,
  };
  const skill: AgentContextItem = {
    body: "# Review",
    description: "Review project changes.",
    health: "normal",
    healthReasons: [],
    id: "skill:/workspace/.agents/skills/review",
    kind: "skill",
    location: { kind: "target", path: ".agents/skills" },
    modifiedAt: null,
    name: "review",
    ownerPath: "/workspace",
    path: "/workspace/.agents/skills/review/SKILL.md",
    providers: ["codex"],
    references: [],
    skill: {
      allowedTools: null,
      compatibility: null,
      license: "MIT",
      metadata: null,
    },
    sources: [
      {
        path: "/workspace/.agents/skills/review",
        readers: [{ agent: "codex", supersededBy: null }],
        target: null,
      },
    ],
    truncated: false,
    unapplied: null,
  };

  const doc = dom.window.document;
  const calls: Array<{ command: string; args: unknown }> = [];
  let openedProviders = 0;

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async function setup() {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(async (command, args) => {
      calls.push({ command, args });
      if (command === "list_artifact_apps") {
        return [
          {
            id: "textedit",
            label: "TextEdit",
            kind: "application",
            isDefault: true,
            icon: null,
          },
        ];
      }
      if (
        command === "open_artifact_in_app" ||
        command === "open_artifact_in_tool"
      ) {
        return null;
      }
      if (command === "agent_adapters_list_identities") {
        return [
          { displayName: "Codex", id: "codex" },
          { displayName: "Claude Code", id: "claude-code" },
        ];
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionDetailPeekHost, useCollectionDetailController } =
      await import("@/features/collection/app-shell");
    const { createAgentAdapterDictionary } =
      await import("@/features/agent-adapters");
    const { createAgentContextItemDetailContent } =
      await import("./item-detail");
    const { createAgentContextItemProperties } =
      await import("./item-properties");
    const properties = createAgentContextItemProperties({
      agents: createAgentAdapterDictionary([
        { displayName: "Codex", id: "codex" },
        { displayName: "Claude Code", id: "claude-code" },
      ]),
      onOpenProviders: () => {
        openedProviders += 1;
      },
    });
    return {
      TooltipProvider,
      CollectionDetailPeekHost,
      useCollectionDetailController,
      detail: (item: AgentContextItem) =>
        createAgentContextItemDetailContent(item, properties),
    };
  }

  function topBar() {
    return doc.querySelector<HTMLElement>("[data-peek-top-bar]")!;
  }

  function sheetHeader() {
    return doc.querySelector<HTMLElement>('[data-slot="sheet-header"]')!;
  }

  test("instruction and skill details open their file with Open with in the top bar", async () => {
    const env = await setup();
    let controller: CollectionDetailController | null = null;
    function CaptureController() {
      controller = env.useCollectionDetailController();
      return null;
    }
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(doc.getElementById("app")!);
      root.render(
        <env.TooltipProvider>
          <CaptureController />
          <env.CollectionDetailPeekHost />
        </env.TooltipProvider>,
      );
      await settle();
    });

    async function open(content: CollectionDetailContent, rowId: string) {
      await act(async () => {
        await controller!.open({
          ...content,
          selection: {
            instanceKey: "agent-context:space:root",
            presentationId: "detail",
            rowId,
          },
        });
        await settle();
      });
    }

    // Instruction: the file name is the identity of the top bar only.
    await open(env.detail(instruction), instruction.id);
    const identity = topBar().querySelector("[data-peek-identity]");
    expect(identity?.textContent).toBe("AGENTS.md");
    expect(sheetHeader().className.includes("sr-only")).toBe(true);
    expect(sheetHeader().textContent?.includes("AGENTS.md")).toBe(true);
    expect(topBar().querySelector('[aria-label="Row actions"]')).toBe(null);
    const buttons = [...topBar().querySelectorAll("button")];
    const primaryIndex = buttons.findIndex((button) =>
      button.hasAttribute("data-external-open-primary"),
    );
    const closeIndex = buttons.findIndex(
      (button) => button.getAttribute("aria-label") === "Close",
    );
    expect(primaryIndex >= 0 && primaryIndex < closeIndex).toBe(true);
    expect(
      buttons.some(
        (button) => button.getAttribute("aria-label") === "Open with",
      ),
    ).toBe(true);
    expect(calls.find((call) => call.command === "list_artifact_apps")).toEqual(
      {
        command: "list_artifact_apps",
        args: {
          target: {
            canonicalArtifactPath: "/workspace/AGENTS.md",
            ownerRoot: "/workspace",
          },
        },
      },
    );

    const primary = topBar().querySelector<HTMLButtonElement>(
      "[data-external-open-primary]",
    )!;
    expect(primary.getAttribute("aria-label")).toBe("Open in TextEdit");
    await act(async () => {
      primary.click();
      await settle();
    });
    expect(calls.at(-1)).toEqual({
      command: "open_artifact_in_app",
      args: {
        target: {
          canonicalArtifactPath: "/workspace/AGENTS.md",
          ownerRoot: "/workspace",
        },
        appId: "textedit",
      },
    });

    await act(async () => {
      topBar()
        .querySelector<HTMLElement>('[aria-label="Open with"]')!
        .dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      await settle();
    });
    await act(async () => {
      doc.querySelector<HTMLElement>("[data-external-open-reveal]")!.click();
      await settle();
    });
    expect(calls.at(-1)).toEqual({
      command: "open_artifact_in_tool",
      args: {
        target: {
          canonicalArtifactPath: "/workspace/AGENTS.md",
          ownerRoot: "/workspace",
        },
        tool: "file_manager",
      },
    });

    // Instruction: no header, the property panel follows the top bar and
    // shows every property but the name the identity already says.
    expect(doc.querySelector("[data-collection-detail-header]")).toBe(null);
    expect(
      doc
        .querySelector('[data-agent-context-item-detail="instruction"]')
        ?.firstElementChild?.hasAttribute("data-collection-property-panel"),
    ).toBe(true);
    expect(
      [...doc.querySelectorAll("[data-collection-panel-property]")].map((row) =>
        row.getAttribute("data-collection-panel-property"),
      ),
    ).toEqual(["type", "providers", "health", "location", "modified"]);

    // Skill: identity in the top bar, a page-like header below it.
    await open(env.detail(skill), skill.id);
    expect(topBar().querySelector("[data-peek-identity]")?.textContent).toBe(
      "review",
    );
    expect(sheetHeader().className.includes("sr-only")).toBe(true);
    const header = doc.querySelector<HTMLElement>(
      "[data-collection-detail-header]",
    )!;
    expect(header.textContent).toBe("reviewReview project changes.");
    expect(
      header.compareDocumentPosition(
        doc.querySelector("[data-collection-property-panel]")!,
      ) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    expect(topBar().querySelector('[aria-label="Row actions"]')).toBe(null);
    await act(async () => {
      topBar()
        .querySelector<HTMLButtonElement>("[data-external-open-primary]")!
        .click();
      await settle();
    });
    expect(calls.at(-1)).toEqual({
      command: "open_artifact_in_app",
      args: {
        target: {
          canonicalArtifactPath: "/workspace/.agents/skills/review/SKILL.md",
          ownerRoot: "/workspace",
        },
        appId: "textedit",
      },
    });

    await act(async () => {
      root?.unmount();
      await settle();
    });
  });

  test("ⓘ details show discovery paths with links and every instruction import with its status", async () => {
    const env = await setup();
    let controller: CollectionDetailController | null = null;
    function CaptureController() {
      controller = env.useCollectionDetailController();
      return null;
    }
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(doc.getElementById("app")!);
      root.render(
        <env.TooltipProvider>
          <CaptureController />
          <env.CollectionDetailPeekHost />
        </env.TooltipProvider>,
      );
      await settle();
    });

    async function openDetails(
      content: CollectionDetailContent,
      rowId: string,
    ) {
      await act(async () => {
        await controller!.open({
          ...content,
          selection: {
            instanceKey: "agent-context:space:root",
            presentationId: "detail",
            rowId,
          },
        });
        await settle();
      });
      const trigger = topBar().querySelector<HTMLButtonElement>(
        "[data-collection-detail-info-trigger]",
      )!;
      // ⓘ stands right after the identity.
      expect(
        topBar().querySelector("[data-peek-identity]")?.nextElementSibling,
      ).toBe(trigger);
      await act(async () => {
        trigger.click();
        await settle();
      });
      return doc.querySelector<HTMLElement>("[data-collection-detail-info]")!;
    }

    const linkedInstruction: AgentContextItem = {
      ...instruction,
      providers: ["claude-code"],
      references: [
        { path: "/workspace/docs/style.md", status: "available" },
        { path: "/etc/outside.md", status: "outside_boundary" },
        { path: "~/.claude/notes.md", status: "requires_client_approval" },
        { path: "/workspace/missing.md", status: "unreadable" },
      ],
      sources: [
        {
          path: "/workspace/AGENTS.md",
          readers: [
            {
              agent: "codex",
              supersededBy: "/workspace/AGENTS.override.md",
            },
          ],
          target: null,
        },
        {
          path: "/workspace/CLAUDE.md",
          readers: [{ agent: "claude-code", supersededBy: null }],
          target: "/workspace/AGENTS.md",
        },
      ],
    };
    let info = await openDetails(
      env.detail(linkedInstruction),
      linkedInstruction.id,
    );
    expect(info.textContent?.includes("Instruction details")).toBe(true);
    // A line per path with the agents reading by it; only the exception is
    // marked.
    expect(
      [
        ...info.querySelectorAll(
          '[data-collection-detail-info-group="sources"] li > code',
        ),
      ].map((code) => code.textContent),
    ).toEqual([
      "/workspace/AGENTS.md",
      "/workspace/CLAUDE.md → /workspace/AGENTS.md",
    ]);
    expect(
      [...info.querySelectorAll("[data-agent-context-readers]")].map(
        (readers) => readers.textContent,
      ),
    ).toEqual([
      "Codex · shadowed by /workspace/AGENTS.override.md",
      "Claude Code",
    ]);
    const imports = [
      ...info.querySelectorAll(
        '[data-collection-detail-info-group="imports"] li',
      ),
    ].map((item) => item.textContent);
    expect(imports).toEqual([
      "/workspace/docs/style.mdAvailable",
      "/etc/outside.mdOutside the scan boundary",
      "~/.claude/notes.mdRequires approval in the client",
      "/workspace/missing.mdCould not be read",
    ]);
    // The peek ends with the content: no sources block after the body.
    const detail = doc.querySelector("[data-agent-context-item-detail]")!;
    expect(detail.lastElementChild?.hasAttribute("data-markdown-reader")).toBe(
      true,
    );
    await act(async () => {
      doc.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      await settle();
    });

    const linkedSkill: AgentContextItem = {
      ...skill,
      sources: [
        skill.sources[0]!,
        {
          path: "/home/user/.claude/skills/review",
          readers: [{ agent: "claude-code", supersededBy: null }],
          target: "/workspace/.agents/skills/review",
        },
      ],
    };
    info = await openDetails(env.detail(linkedSkill), linkedSkill.id);
    expect(info.textContent?.includes("Skill details")).toBe(true);
    expect(
      [
        ...info.querySelectorAll(
          '[data-collection-detail-info-group="sources"] li > code',
        ),
      ].map((item) => item.textContent),
    ).toEqual([
      "/workspace/.agents/skills/review",
      "/home/user/.claude/skills/review → /workspace/.agents/skills/review",
    ]);
    // A skill has no imports group.
    expect(
      info.querySelector('[data-collection-detail-info-group="imports"]'),
    ).toBe(null);

    await act(async () => {
      root?.unmount();
      await settle();
    });
  });

  test("an empty Providers row explains itself in the panel and leads to Providers", async () => {
    const env = await setup();
    let controller: CollectionDetailController | null = null;
    function CaptureController() {
      controller = env.useCollectionDetailController();
      return null;
    }
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(doc.getElementById("app")!);
      root.render(
        <env.TooltipProvider>
          <CaptureController />
          <env.CollectionDetailPeekHost />
        </env.TooltipProvider>,
      );
      await settle();
    });
    const unread: AgentContextItem = {
      ...skill,
      providers: [],
      sources: [],
      unapplied: { kind: "not_found", readers: ["claude-code"] },
    };
    await act(async () => {
      await controller!.open({
        ...env.detail(unread),
        selection: {
          instanceKey: "agent-context:space:root",
          presentationId: "all",
          rowId: unread.id,
        },
      });
      await settle();
    });

    const reason = doc.querySelector<HTMLElement>(
      "[data-agent-context-providers-reason]",
    )!;
    expect(reason.textContent).toBe(
      "-No enabled agent finds itRead by their own rules: Claude CodeOpen Providers",
    );
    // No agent finds it by an enabled path: no "Sources" and no ⓘ.
    expect(
      topBar().querySelector("[data-collection-detail-info-trigger]"),
    ).toBe(null);
    await act(async () => {
      reason.querySelector("button")!.click();
      await settle();
    });
    expect(openedProviders).toBe(1);

    await act(async () => {
      root?.unmount();
      await settle();
    });
  });
}
