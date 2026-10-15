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
        readers: [
          {
            agent: "codex",
            disabled: false,
            supersededBy: null,
            unverified: false,
          },
        ],
        target: null,
      },
    ],
    truncated: false,
    unapplied: null,
    components: [],
    icon: null,
    managedBySvode: false,
    plugin: null,
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
      directory: "/workspace/.agents/skills/review",
      hasFiles: false,
      allowedTools: null,
      compatibility: null,
      license: "MIT",
      metadata: null,
    },
    sources: [
      {
        path: "/workspace/.agents/skills/review",
        readers: [
          {
            agent: "codex",
            disabled: false,
            supersededBy: null,
            unverified: false,
          },
        ],
        target: null,
      },
    ],
    truncated: false,
    unapplied: null,
    components: [],
    icon: null,
    managedBySvode: false,
    plugin: null,
  };

  const doc = dom.window.document;
  const calls: Array<{ command: string; args: unknown }> = [];
  let openedProviders = 0;

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  /** Settles until `ready` holds: lazy chunks load at their own pace. */
  async function settleUntil(ready: () => boolean) {
    for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
      await act(async () => {
        await settle();
      });
    }
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
      if (command === "agent_context_list_skill_files") {
        const { path } = args as { path: string };
        const file = (
          kind: string,
          relative: string,
          sizeBytes: number | null = null,
        ) => ({
          availability: "available",
          canonicalPath: `/workspace/.agents/skills/review/${relative}`,
          format: kind === "directory" ? "" : relative.split(".").at(-1),
          kind,
          modifiedAt: "2026-10-15T08:00:00Z",
          name: relative.split("/").at(-1),
          path: relative,
          sizeBytes,
        });
        return path === ""
          ? {
              files: [
                file("directory", "assets"),
                file("markdown", "guide.md"),
              ],
              path,
            }
          : { files: [file("media", "assets/logo.png", 2048)], path };
      }
      if (command === "agent_context_read_skill_file") {
        return {
          bytesRead: 7,
          markdown: "# Guide",
          totalBytes: 7,
          truncated: false,
        };
      }
      if (command === "agent_context_create_skill_media_source") {
        throw { kind: "unsupported_format", message: "Not previewable" };
      }
      if (command.startsWith("plugin:event|")) return 1;
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
        createAgentContextItemDetailContent(item, properties, {
          onOpenProviders: () => {
            openedProviders += 1;
          },
        }),
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
              disabled: false,
              unverified: false,
            },
          ],
          target: null,
        },
        {
          path: "/workspace/CLAUDE.md",
          readers: [
            {
              agent: "claude-code",
              disabled: false,
              supersededBy: null,
              unverified: false,
            },
          ],
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
          readers: [
            {
              agent: "claude-code",
              disabled: false,
              supersededBy: null,
              unverified: false,
            },
          ],
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

  test("a skill shows Skill and Attachments tabs; its files open read-only in the same peek", async () => {
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
    async function open(item: AgentContextItem) {
      await act(async () => {
        await controller!.open({
          ...env.detail(item),
          selection: {
            instanceKey: "agent-context:space:root",
            presentationId: "all",
            rowId: item.id,
          },
        });
        await settle();
      });
    }
    const tabs = () =>
      doc.querySelector<HTMLElement>("[data-agent-context-item-tabs]");
    const rows = () =>
      [...doc.querySelectorAll<HTMLElement>("[data-collection-row]")].map(
        (row) => row.dataset.collectionRow,
      );
    const row = (id: string) =>
      doc.querySelector<HTMLElement>(`[data-collection-row="${id}"]`)!;

    // Without supported files: the body alone, without a tab strip.
    await open(skill);
    expect(tabs()?.dataset.agentContextItemTabs).toBe("skill");
    expect(tabs()?.querySelector('[role="tablist"]')).toBe(null);
    expect(tabs()?.querySelector("[data-markdown-reader]")?.textContent).toBe(
      "Review",
    );

    // An instruction: its text, no tabs.
    await open(instruction);
    expect(tabs()).toBe(null);

    // With supported files: Skill first, then Attachments.
    await open({ ...skill, skill: { ...skill.skill!, hasFiles: true } });
    expect(
      [...tabs()!.querySelectorAll('[role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Skill", "Attachments"]);
    expect(tabs()!.dataset.agentContextItemTabs).toBe("skill");
    await act(async () => {
      tabs()!
        .querySelectorAll<HTMLElement>('[role="tab"]')[1]!
        .dispatchEvent(
          new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
      await settle();
    });
    await settleUntil(() => rows().length > 0);
    expect(tabs()!.dataset.agentContextItemTabs).toBe("files");
    expect(
      calls.find((call) => call.command === "agent_context_list_skill_files"),
    ).toEqual({
      command: "agent_context_list_skill_files",
      args: { itemId: skill.id, path: "" },
    });
    expect(rows()).toEqual(["directory:assets", "markdown:guide.md"]);
    // Folders expand in place, as in Attachments.
    await act(async () => {
      row("directory:assets")
        .querySelector<HTMLElement>("[aria-expanded]")!
        .click();
      await settle();
    });
    expect(rows()).toEqual([
      "directory:assets",
      "media:assets/logo.png",
      "markdown:guide.md",
    ]);
    expect(row("media:assets/logo.png").textContent?.includes("Media")).toBe(
      true,
    );

    // Markdown opens in the same peek, read-only.
    await act(async () => {
      row("markdown:guide.md")
        .querySelector<HTMLElement>("[data-collection-primary]")!
        .click();
      await settle();
    });
    expect(topBar().querySelector("[data-peek-identity]")?.textContent).toBe(
      "guide.md",
    );
    expect(calls.at(-1)).toEqual({
      command: "agent_context_read_skill_file",
      args: { itemId: skill.id, path: "guide.md" },
    });
    const file = doc.querySelector<HTMLElement>(
      '[data-agent-context-skill-file="ready"]',
    )!;
    expect(file.querySelector("[data-markdown-reader]")?.textContent).toBe(
      "Guide",
    );
    expect(doc.querySelector('[contenteditable="true"]')).toBe(null);
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
          canonicalArtifactPath: "/workspace/.agents/skills/review/guide.md",
          ownerRoot: "/workspace",
        },
        appId: "textedit",
      },
    });

    // Media opens in its own viewer by the absolute path, without Changes or
    // a full page.
    await open({ ...skill, skill: { ...skill.skill!, hasFiles: true } });
    await act(async () => {
      tabs()!
        .querySelectorAll<HTMLElement>('[role="tab"]')[1]!
        .dispatchEvent(
          new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
      await settle();
    });
    await settleUntil(() => rows().length > 0);
    await act(async () => {
      row("directory:assets")
        .querySelector<HTMLElement>("[aria-expanded]")!
        .click();
      await settle();
    });
    await act(async () => {
      row("media:assets/logo.png")
        .querySelector<HTMLElement>("[data-collection-primary]")!
        .click();
      await settle();
    });
    await settleUntil(() =>
      calls.some(
        (call) => call.command === "agent_context_create_skill_media_source",
      ),
    );
    expect(
      calls.find(
        (call) => call.command === "agent_context_create_skill_media_source",
      ),
    ).toEqual({
      command: "agent_context_create_skill_media_source",
      args: { itemId: skill.id, path: "assets/logo.png" },
    });
    expect(topBar().querySelector("[data-peek-identity]")?.textContent).toBe(
      "logo.png",
    );
    expect(doc.querySelectorAll("[data-peek-top-bar]").length).toBe(1);
    expect(topBar().querySelector('[aria-label="Expand"]')).toBe(null);
    expect(topBar().querySelector('[aria-label="Close"]') === null).toBe(false);

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

  test("a plugin shows its manifest, README and components, which open in the same peek", async () => {
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
    async function open(item: AgentContextItem) {
      await act(async () => {
        await controller!.open({
          ...env.detail(item),
          selection: {
            instanceKey: "agent-context:space:root",
            presentationId: "all",
            rowId: item.id,
          },
        });
        await settle();
      });
    }
    const tabs = () =>
      doc.querySelector<HTMLElement>("[data-agent-context-item-tabs]");
    const tabLabels = () =>
      [...(tabs()?.querySelectorAll('[role="tab"]') ?? [])].map(
        (tab) => tab.textContent,
      );
    const component: AgentContextItem = {
      ...skill,
      id: "plugin:/home/user/kit#skill:/home/user/kit/skills/review",
      ownerPath: "/home/user/kit",
      path: "/home/user/kit/skills/review/SKILL.md",
    };
    const plugin: AgentContextItem = {
      ...skill,
      body: "# Kit\nAbout the kit.",
      components: [component],
      description: "Team kit",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      id: "plugin:/home/user/kit",
      kind: "plugin",
      name: "kit",
      ownerPath: "/home/user/kit",
      path: "/home/user/kit/.claude-plugin/plugin.json",
      plugin: {
        composition: "declared",
        counts: [{ count: 3, kind: "commands" }],
        directory: "/home/user/kit",
        hasReadme: true,
        manifest: {
          author: "Team",
          file: "plugin.json",
          homepage: null,
          keywords: ["team"],
          license: null,
          repository: null,
          version: "1.2.0",
        },
      },
      skill: null,
    };

    await open(plugin);
    expect(
      doc
        .querySelector("[data-peek-identity] img[data-agent-context-icon]")
        ?.getAttribute("src"),
    ).toBe(plugin.icon);
    expect(
      doc.querySelector('[data-collection-panel-fact-group="plugin-manifest"]')
        ?.textContent,
    ).toBe("From plugin.json");
    expect(
      doc
        .querySelector('[data-collection-panel-fact="version"]')
        ?.textContent?.includes("1.2.0"),
    ).toBe(true);
    expect(tabLabels()).toEqual(["Description", "Components"]);
    expect(
      tabs()
        ?.querySelector("[data-markdown-reader]")
        ?.textContent?.includes("About the kit."),
    ).toBe(true);
    await act(async () => {
      tabs()!
        .querySelectorAll<HTMLElement>('[role="tab"]')[1]!
        .dispatchEvent(
          new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
      await settle();
    });
    expect(
      doc.querySelector("[data-agent-context-plugin-counts]")?.textContent,
    ).toBe("Also: commands: 3");
    const componentRow = doc.querySelector<HTMLElement>(
      `[data-collection-row="${component.id}"]`,
    )!;
    expect(componentRow.textContent?.includes("review")).toBe(true);
    await act(async () => {
      componentRow
        .querySelector<HTMLElement>("[data-collection-primary]")!
        .click();
      await settle();
    });
    expect(topBar().querySelector("[data-peek-identity]")?.textContent).toBe(
      "review",
    );
    expect(doc.querySelectorAll("[data-peek-top-bar]").length).toBe(1);

    // Without README there is no Description; a code plugin says why it
    // has no components.
    await open({
      ...plugin,
      components: [],
      plugin: { ...plugin.plugin!, composition: "code", hasReadme: false },
    });
    expect(tabLabels()).toEqual([]);
    expect(
      doc
        .querySelector("[data-agent-context-plugin-code]")
        ?.textContent?.includes("code defines what it brings"),
    ).toBe(true);

    // The Svode integration: its logo and the way to Providers.
    await open({ ...plugin, managedBySvode: true });
    expect(
      doc
        .querySelector("[data-peek-identity] img[data-agent-context-icon]")
        ?.getAttribute("data-agent-context-icon"),
    ).toBe("svode");
    const managed = doc.querySelector<HTMLElement>(
      '[data-collection-panel-fact="managed-by-svode"]',
    )!;
    expect(managed.textContent).toBe("Managed by SvodeOpen Providers");
    const before = openedProviders;
    await act(async () => {
      managed.querySelector("button")!.click();
      await settle();
    });
    expect(openedProviders).toBe(before + 1);

    await act(async () => {
      root?.unmount();
      await settle();
    });
  });
}
