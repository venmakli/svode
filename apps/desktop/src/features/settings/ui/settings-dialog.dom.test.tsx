import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SettingsDestination } from "../model/settings-destination";

if (process.env.SVODE_UNIFIED_SETTINGS_DOM !== "1") {
  test("unified settings destinations, owner isolation and guards", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_UNIFIED_SETTINGS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 20000);
} else {
  const mock = (
    bunTest as typeof bunTest & {
      mock: { module(name: string, factory: () => unknown): void };
    }
  ).mock;
  let activeRootPath: string | null = "/project";
  const spaces = [
    { id: "docs", name: "Docs", path: "/project/docs", status: "ready" },
    { id: "other", name: "Other", path: "/project/other", status: "ready" },
  ];
  // Storage writes in flight per owner path.
  const pendingOwners = new Set<string>();
  const applyingOwners = new Set<string>();
  // Whether each storage owner's details (S3, LFS, diagnostics) are loading.
  const storageOpen = new Map<string, boolean>();
  const loads = new Map<string, (value: unknown) => void>();
  const noop = () => {};
  mock.module("@/features/space", () => ({
    useSpace: (selector?: (state: unknown) => unknown) => {
      const state = {
        activeRootPath,
        activeRootId: "project",
        activeRootName: "Long project ".repeat(15),
        spaces: activeRootPath ? spaces : [],
        patchSpaceMetadata: noop,
      };
      return selector ? selector(state) : state;
    },
    CreateSpaceDialog: ({ open }: { open: boolean }) =>
      open ? <div data-create-space /> : null,
  }));
  mock.module("@/features/page/navigation", () => ({
    useOpenPage: () => noop,
  }));
  const variableReads: unknown[] = [];
  let variableWrite: Promise<void> = Promise.resolve();
  mock.module("../api", () => ({
    getAppVariables: async (_context: unknown, scope: unknown) => {
      variableReads.push(scope);
      return {
        entries: [],
        owners: [
          {
            owner: { scope: "project" },
            label: "Project",
            revision: "r1",
            error: null,
          },
        ],
        defaultOwner: { scope: "project" },
        bindingRevision: "b1",
      };
    },
    listenAppVariablesChanged: async () => noop,
    upsertAppVariable: async () => {
      await variableWrite;
      return { effects: [], recoveryError: null };
    },
    removeAppVariable: async () => {},
    setAppVariableBinding: async () => {},
    recoverAppVariables: async () => {},
    getSettingsSpaceConfig: (path: string) =>
      new Promise((resolve) => loads.set(path, resolve)),
  }));
  mock.module("../hooks/use-space-settings-config-actions", () => ({
    useSpaceSettingsConfigActions: () => ({ saveConfig: async () => true }),
  }));
  for (const [file, name] of [
    ["use-space-settings-agent", "useSpaceSettingsAgent"],
    ["use-space-settings-defaults", "useSpaceSettingsDefaults"],
    ["use-space-settings-health", "useSpaceSettingsHealth"],
  ])
    mock.module(`../hooks/${file}`, () => ({ [name]: () => ({}) }));
  // Repository types by space id; an empty map is a type still loading.
  let gitTypes: Record<string, string> = {
    docs: "independent",
    other: "submodule",
  };
  mock.module("../hooks/use-project-space-git-types", () => ({
    useProjectSpaceGitTypes: () => gitTypes,
  }));
  mock.module("../hooks/use-space-settings-git", () => ({
    useSpaceSettingsGit: () => ({
      gitType: "independent",
      pendingRemote: null,
    }),
  }));
  mock.module("../hooks/use-space-settings-identity", () => ({
    useSpaceSettingsIdentity: () => ({
      handleCancelIdentityEdit: noop,
      handleStartIdentityEdit: noop,
    }),
  }));
  mock.module("../hooks/use-space-storage-settings", () => ({
    useSpaceStorageSettings: ({
      open,
      detailsActive = open,
      spacePath,
    }: {
      open: boolean;
      detailsActive?: boolean;
      spacePath: string;
    }) => {
      storageOpen.set(spacePath, open && detailsActive);
      return {
        currentSpacePath: spacePath,
        storageConfigLoaded: true,
        savedAssetsStrategy: "in-git",
        applyingStrategy: applyingOwners.has(spacePath),
        s3: { pending: pendingOwners.has(spacePath), cancel: noop },
      };
    },
  }));
  mock.module("./app-settings-content", () => ({
    AppSettingsContent: ({ section }: { section: string }) => {
      const [draft, setDraft] = useState("");
      return (
        <div data-app-section={section}>
          <input
            aria-label="Global draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      );
    },
  }));
  mock.module("./space-general-section", () => ({
    SpaceGeneralSection: ({
      path,
      editor,
    }: {
      path: string;
      editor?: { name: string };
    }) => (
      <div data-general-path={path} data-general-name={editor?.name ?? ""} />
    ),
  }));
  mock.module("./space-git-section", () => ({
    SpaceGitSection: ({ spacePath }: { spacePath: string }) => (
      <div data-repository={spacePath} />
    ),
    SpaceGitSummary: ({ repositoryPath }: { repositoryPath: string }) => (
      <span data-git-summary={repositoryPath} />
    ),
  }));
  mock.module("./storage-section", () => ({
    StorageSettingsSection: ({
      settings,
    }: {
      settings: { currentSpacePath: string };
    }) => <div data-storage={settings.currentSpacePath} />,
    StorageStrategyConfirmDialog: () => null,
    StorageInheritedGroup: ({
      strategy,
      onOpenProject,
    }: {
      strategy: string | null;
      onOpenProject: () => void;
    }) => (
      <button data-storage-inherited={strategy ?? ""} onClick={onOpenProject}>
        Project storage
      </button>
    ),
    storageSummary: (settings: { currentSpacePath: string }) =>
      `Storage of ${settings.currentSpacePath}`,
  }));
  for (const [file, name] of [
    ["space-agent-section", "SpaceAgentSection"],
    ["space-defaults-section", "SpaceDefaultsSection"],
    ["space-health-section", "SpaceHealthSection"],
    ["space-instructions-section", "SpaceInstructionsSection"],
  ])
    mock.module(`./${file}`, () => ({
      [name]: () => <div data-section={name} />,
    }));

  test("one real Dialog preserves navigation, pending guards, owner blocks, focus and no-project scope", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><button id=trigger data-settings-return-focus>Settings</button><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost" },
    );
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      attachEvent: {
        configurable: true,
        value(this: HTMLElement, name: string, listener: EventListener) {
          this.addEventListener(name.replace(/^on/, ""), listener);
        },
      },
      detachEvent: {
        configurable: true,
        value(this: HTMLElement, name: string, listener: EventListener) {
          this.removeEventListener(name.replace(/^on/, ""), listener);
        },
      },
    });
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const values: Record<string, unknown> = {
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      DocumentFragment: dom.window.DocumentFragment,
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
    };
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
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
    const scrolled: Element[] = [];
    dom.window.HTMLElement.prototype.scrollIntoView = function (
      this: HTMLElement,
    ) {
      scrolled.push(this);
    };
    const { SettingsDialog } = await import("./settings-dialog");
    const { setLocale } = await import("@/paraglide/runtime");
    setLocale("en", { reload: false });
    const document = dom.window.document;
    const root = createRoot(document.getElementById("app")!);
    const trigger = document.getElementById("trigger")!;
    trigger.focus();
    let closed = false;
    let request: SettingsDestination = {
      scope: "app",
      section: "git-identity",
    };
    const draw = async (next = request, legacy = false) => {
      request = next;
      await act(async () => {
        root.render(
          <SettingsDialog
            shortcutGroups={[]}
            destination={request}
            enableLegacyAgentIntegration={legacy}
            onClose={() => {
              closed = true;
              root.render(null);
            }}
          />,
        );
        await tick();
      });
      await act(tick);
    };
    const press = async (button: HTMLElement) => {
      await act(async () => {
        button.click();
        await tick();
      });
      await act(tick);
    };
    const click = async (label: string) => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((item) => item.textContent === label);
      if (!button) throw new Error(`Missing button ${label}`);
      await press(button);
    };
    const escape = async () => {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await tick();
      });
    };
    const project = (
      section: "general" | "git" | "storage" | "variables",
      spacePath = "/project",
    ): SettingsDestination => ({ scope: "project", section, spacePath });
    const pageTitle = () =>
      document.querySelector("main > header h2")?.textContent;
    const ownerHeading = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("section > h3")).find(
        (heading) => heading.querySelector("span[id]")?.textContent === name,
      )!;
    const ownerTrigger = (name: string) =>
      ownerHeading(name).querySelector<HTMLButtonElement>("button")!;
    const attributes = (selector: string, name: string) =>
      Array.from(document.querySelectorAll(selector)).map((node) =>
        node.getAttribute(name),
      );
    try {
      await draw();
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
      expect(
        document.querySelector('[data-app-section="git-identity"]') !== null,
      ).toBe(true);
      expect(document.querySelector('[role="combobox"]') !== null).toBe(true);
      expect(
        document.querySelector('[data-slot="sidebar-group-label"]')
          ?.textContent,
      ).toBe("Svode");
      expect(pageTitle()).toBe("Profile");
      expect(document.querySelector('[data-slot="breadcrumb"]')).toBeNull();
      const navLabels = Array.from(
        document.querySelectorAll('[data-slot="sidebar-menu-button"]'),
      ).map((node) => node.textContent);
      expect(navLabels).toEqual([
        "Profile",
        "Appearance",
        "Global variables",
        "MCP Integrations",
        "Shortcuts",
        "About",
        "General",
        "Variables",
        "Git",
        "Storage",
      ]);
      const compactSelect =
        document.querySelector<HTMLElement>('[role="combobox"]')!;
      await act(async () => {
        compactSelect.focus();
        compactSelect.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          }),
        );
        await tick();
      });
      await act(tick);
      expect(
        Array.from(document.querySelectorAll('[role="option"]')).map(
          (node) => node.textContent,
        ),
      ).toEqual(navLabels);
      const appearanceOption = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((node) => node.textContent === "Appearance")!;
      await act(async () => {
        appearanceOption.focus();
        appearanceOption.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
          }),
        );
        await tick();
      });
      expect(
        document.querySelector('[data-app-section="appearance"]') !== null,
      ).toBe(true);
      expect(pageTitle()).toBe("Appearance");

      // Storage: the project block is open; a repository block summarizes
      // its strategy in the heading and loads its details only once opened.
      await click("Storage");
      expect(pageTitle()).toBe("Storage");
      expect(document.querySelector('[data-slot="breadcrumb"]')).toBeNull();
      expect(attributes("[data-storage]", "data-storage")).toEqual([
        "/project",
      ]);
      expect(storageOpen.get("/project")).toBe(true);
      expect(storageOpen.get("/project/docs")).toBe(false);
      expect(ownerTrigger("Docs").getAttribute("aria-expanded")).toBe("false");
      expect(
        ownerTrigger("Docs").textContent?.includes("Storage of /project/docs"),
      ).toBe(true);
      expect(
        ownerTrigger("Other").textContent?.includes(
          "Storage of /project/other",
        ),
      ).toBe(true);
      pendingOwners.add("/project");
      await draw();
      await click("Profile");
      await escape();
      await draw({ scope: "app", section: "appearance" });
      expect(closed).toBe(false);
      expect(pageTitle()).toBe("Storage");
      pendingOwners.clear();
      applyingOwners.add("/project");
      await draw();
      await click("Profile");
      expect(pageTitle()).toBe("Storage");
      applyingOwners.clear();

      // A space's write keeps blocking while its block is collapsed.
      await press(ownerTrigger("Docs"));
      expect(ownerTrigger("Docs").getAttribute("aria-expanded")).toBe("true");
      expect(storageOpen.get("/project/docs")).toBe(true);
      expect(attributes("[data-storage]", "data-storage")).toEqual([
        "/project",
        "/project/docs",
      ]);
      applyingOwners.add("/project/docs");
      await draw();
      await press(ownerTrigger("Docs"));
      expect(attributes("[data-storage]", "data-storage")).toEqual([
        "/project",
      ]);
      expect(storageOpen.get("/project/docs")).toBe(true);
      await click("Profile");
      expect(pageTitle()).toBe("Storage");
      applyingOwners.clear();
      await draw();
      await click("Profile");
      expect(
        document.querySelector('[data-app-section="git-identity"]') !== null,
      ).toBe(true);
      expect(document.querySelector("[data-storage]")).toBeNull();

      // A contextual Git entry opens the page with the owner's block open,
      // scrolled into view and focused.
      await draw(project("git", "/project/docs"));
      expect(pageTitle()).toBe("Git");
      expect(attributes("[data-repository]", "data-repository")).toEqual([
        "/project",
        "/project/docs",
      ]);
      expect(ownerTrigger("Docs").getAttribute("aria-expanded")).toBe("true");
      expect(ownerTrigger("Other").getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(ownerTrigger("Docs"));
      expect(scrolled.at(-1)).toBe(ownerTrigger("Docs"));
      await draw(project("git", "/project/other"));
      expect(ownerTrigger("Other").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(ownerTrigger("Other"));
      expect(attributes("[data-repository]", "data-repository")).toEqual([
        "/project",
        "/project/docs",
        "/project/other",
      ]);
      // A repository block summarizes its access and remote in the heading;
      // the project block has no summary.
      expect(attributes("[data-git-summary]", "data-git-summary")).toEqual([
        "/project/docs",
        "/project/other",
      ]);
      expect(
        ownerTrigger("Docs").querySelector("[data-git-summary]") === null,
      ).toBe(false);

      // An inline space only points to the project repository: its heading
      // takes the request, and its link shows the project block.
      gitTypes = { docs: "independent", other: "inline" };
      await draw(project("git", "/project/other"));
      expect(ownerHeading("Other").querySelector("button")).toBeNull();
      expect(document.activeElement).toBe(ownerHeading("Other"));
      expect(attributes("[data-repository]", "data-repository")).toEqual([
        "/project",
        "/project/docs",
      ]);
      expect(
        ownerHeading("Other")
          .closest("section")
          ?.textContent?.includes(
            `Part of the “${"Long project ".repeat(15)}” project repository`,
          ),
      ).toBe(true);
      await click("Project Git");
      expect(document.activeElement).toBe(
        ownerHeading("Long project ".repeat(15)),
      );
      expect(scrolled.at(-1)).toBe(ownerHeading("Long project ".repeat(15)));

      // On Storage an inline space only names the project strategy: it runs
      // no storage lifecycle of its own and its link shows the project.
      storageOpen.clear();
      await draw(project("storage", "/project/other"));
      expect(ownerHeading("Other").querySelector("[aria-expanded]")).toBeNull();
      expect(document.activeElement).toBe(ownerHeading("Other"));
      expect(
        attributes("[data-storage-inherited]", "data-storage-inherited"),
      ).toEqual(["in-git"]);
      expect(storageOpen.has("/project/other")).toBe(false);
      expect(attributes("[data-storage]", "data-storage")).toEqual([
        "/project",
      ]);
      await click("Project storage");
      expect(document.activeElement).toBe(
        ownerHeading("Long project ".repeat(15)),
      );

      // A request for a space waits for its repository type, then reveals
      // the block in its final shape.
      gitTypes = {};
      await draw(project("git", "/project/docs"));
      expect(document.querySelector("[data-git-summary]")).toBeNull();
      expect(ownerHeading("Docs").querySelector("button")).toBeNull();
      expect(document.activeElement === ownerHeading("Docs")).toBe(false);
      gitTypes = { docs: "independent", other: "submodule" };
      await draw();
      expect(ownerTrigger("Docs").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(ownerTrigger("Docs"));

      // Every owner's details load on their own; a late answer for one
      // owner never lands in another owner's form.
      await draw(project("general", "/project/docs"));
      expect(pageTitle()).toBe("General");
      expect(attributes("[data-general-path]", "data-general-path")).toEqual([
        "/project",
        "/project/docs",
        "/project/other",
      ]);
      expect(document.activeElement).toBe(ownerHeading("Docs"));
      expect(scrolled.at(-1)).toBe(ownerHeading("Docs"));
      await act(tick);
      await act(async () => {
        loads.get("/project/other")!({
          name: "Other canonical",
          description: "",
          icon: "",
        });
        loads.get("/project")!({
          name: "Project canonical",
          description: "",
          icon: "",
        });
        await tick();
      });
      await act(async () => {
        loads.get("/project/docs")!({
          name: "Docs canonical",
          description: "",
          icon: "",
        });
        await tick();
      });
      expect(attributes("[data-general-path]", "data-general-name")).toEqual([
        "Project canonical",
        "Docs canonical",
        "Other canonical",
      ]);
      await click("Add space");
      expect(document.querySelector("[data-create-space]") !== null).toBe(true);

      await draw(project("git", "/missing"));
      expect(document.querySelector("[data-repository]")).toBeNull();
      expect(document.querySelector("[data-create-space]")).toBeNull();
      expect(document.body.textContent?.includes("no longer available")).toBe(
        true,
      );

      const scopesReadSince = (start: number) =>
        [
          ...new Set(
            variableReads.slice(start).map((scope) => JSON.stringify(scope)),
          ),
        ].sort();
      const everyOwner = [null, "docs", "other"]
        .map((spaceId) => JSON.stringify({ projectPath: "/project", spaceId }))
        .sort();
      let reads = variableReads.length;
      await draw(project("variables"));
      expect(scopesReadSince(reads)).toEqual(everyOwner);
      expect(
        Array.from(document.querySelectorAll("section > h3 span[id]")).map(
          (node) => node.textContent?.trim(),
        ),
      ).toEqual(["Long project ".repeat(15).trim(), "Docs", "Other"]);
      reads = variableReads.length;
      await draw(project("variables", "/project/other"));
      expect(scopesReadSince(reads)).toEqual([]);
      expect(document.activeElement).toBe(ownerHeading("Other"));
      // A pending Variables write blocks leaving the section.
      let finishWrite!: () => void;
      variableWrite = new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      await click("Add variable");
      const nameInput = document.querySelector<HTMLInputElement>(
        'form input[id$="-name"]',
      )!;
      await act(async () => {
        nameInput.focus();
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(nameInput, "PENDING");
        nameInput.dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
        const propertyChange = new dom.window.Event("propertychange", {
          bubbles: true,
        });
        Object.defineProperty(propertyChange, "propertyName", {
          value: "value",
        });
        nameInput.dispatchEvent(propertyChange);
      });
      await click("Save");
      await click("Profile");
      expect(document.querySelector("[data-app-section]")).toBeNull();
      expect(
        document.querySelector('form[aria-label="Add variable"]') !== null,
      ).toBe(true);
      await act(async () => {
        finishWrite();
        await tick();
      });
      await act(tick);
      expect(document.querySelector('form[aria-label="Add variable"]')).toBe(
        null,
      );
      await click("Profile");
      expect(
        document.querySelector('[data-app-section="git-identity"]') !== null,
      ).toBe(true);

      // Opening Settings straight from a Git entry keeps focus on the
      // owner's heading instead of the dialog's first control.
      await act(async () => {
        root.render(null);
        await tick();
      });
      await draw(project("git", "/project/other"));
      expect(ownerTrigger("Other").getAttribute("aria-expanded")).toBe("true");
      expect(ownerTrigger("Docs").getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(ownerTrigger("Other"));

      await draw({ scope: "app", section: "git-identity" }, true);
      expect(document.body.textContent?.includes("CLI Agents")).toBe(true);
      expect(document.body.textContent?.includes("AI Agent")).toBe(true);
      activeRootPath = null;
      await draw(project("git", "/project/docs"));
      expect(
        document.querySelectorAll('[data-slot="sidebar-group-label"]').length,
      ).toBe(1);
      expect(document.querySelector("[data-repository]")).toBeNull();
      await click("Profile");
      await escape();
      await act(tick);
      expect(closed).toBe(true);
      expect(document.activeElement).toBe(trigger);
    } finally {
      await act(async () => {
        root.unmount();
        await tick();
      });
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  }, 15000);
}
function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}
