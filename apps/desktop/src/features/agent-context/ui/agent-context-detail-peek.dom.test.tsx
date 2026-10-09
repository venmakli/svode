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

import type {
  AgentContextInstructionRow,
  AgentContextSkillRow,
} from "../model/types";

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

  const instruction: AgentContextInstructionRow = {
    adapterId: "codex",
    body: "# Project instructions",
    canonicalPath: "/workspace/AGENTS.md",
    discoveryPath: "/workspace/AGENTS.md",
    filename: "AGENTS.md",
    health: "normal",
    healthReasons: [],
    id: "codex:project:/workspace/AGENTS.md",
    linkKind: "direct",
    linkTargetPath: null,
    location: "space",
    ownerPath: "/workspace",
    precedence: 1,
    references: [],
    role: "codex_directory_precedence",
    support: "client_native",
    resolution: "selected",
    truncated: false,
  };
  const skill: AgentContextSkillRow = {
    allowedTools: null,
    aliases: [
      {
        discoveryPath: "/workspace/.agents/skills/review",
        linkKind: "direct",
        location: "space",
        resolution: "selected",
        sourceFamily: "agents",
        support: "client_native",
      },
    ],
    body: "# Review",
    canonicalPath: "/workspace/.agents/skills/review",
    compatibility: null,
    description: "Review project changes.",
    health: "normal",
    healthReasons: [],
    id: "skill:/workspace/.agents/skills/review",
    license: null,
    manifestPath: "/workspace/.agents/skills/review/SKILL.md",
    metadata: null,
    name: "review",
    ownerPath: "/workspace",
    truncated: false,
  };

  const doc = dom.window.document;
  const calls: Array<{ command: string; args: unknown }> = [];

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
      throw new Error(`Unexpected command: ${command}`);
    });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionDetailPeekHost, useCollectionDetailController } =
      await import("@/features/collection/app-shell");
    const { createInstructionDetailContent } =
      await import("./instructions-presentation");
    const { createSkillDetailContent } = await import("./skills-presentation");
    return {
      TooltipProvider,
      CollectionDetailPeekHost,
      useCollectionDetailController,
      createInstructionDetailContent,
      createSkillDetailContent,
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
    await open(env.createInstructionDetailContent(instruction), instruction.id);
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

    // Skill: the identity block below the top bar stays; Open with replaces ⋯.
    await open(env.createSkillDetailContent(skill), skill.id);
    expect(topBar().querySelector("[data-peek-identity]")).toBe(null);
    expect(sheetHeader().className.includes("sr-only")).toBe(false);
    expect(sheetHeader().textContent?.includes("review")).toBe(true);
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
}
