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
    { id: "docs", name: "Docs", path: "/project/docs" },
    { id: "other", name: "Other", path: "/project/other" },
  ];
  let pending = false;
  let applying = false;
  let cancellations = 0;
  let identityCancellations = 0;
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
  mock.module("../api", () => ({
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
    ["use-project-space-git-types", "useProjectSpaceGitTypes"],
  ])
    mock.module(`../hooks/${file}`, () => ({ [name]: () => ({}) }));
  mock.module("../hooks/use-space-settings-git", () => ({
    useSpaceSettingsGit: () => ({
      gitType: "independent",
      pendingRemote: null,
    }),
  }));
  mock.module("../hooks/use-space-settings-identity", () => ({
    useSpaceSettingsIdentity: () => ({
      handleCancelIdentityEdit: () => {
        identityCancellations++;
      },
      handleStartIdentityEdit: noop,
    }),
  }));
  mock.module("../hooks/use-space-storage-settings", () => ({
    useSpaceStorageSettings: () => ({
      applyingStrategy: applying,
      s3: {
        pending,
        cancel: () => {
          cancellations++;
        },
      },
    }),
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
    SpaceGeneralSection: ({ name }: { name: string }) => (
      <div data-general-name={name}>{name}</div>
    ),
  }));
  mock.module("./space-settings-spaces-section", () => ({
    ProjectSpacesSection: ({
      onAddSpace,
      onOpenSpaceDetail,
    }: {
      onAddSpace(): void;
      onOpenSpaceDetail(id: string, section: string): void;
    }) => (
      <>
        <button onClick={onAddSpace}>Create space</button>
        <button onClick={() => onOpenSpaceDetail("docs", "general")}>
          Docs general
        </button>
      </>
    ),
    ProjectSpacePolicyList: ({
      section,
      onOpenSpaceDetail,
    }: {
      section: string;
      onOpenSpaceDetail(id: string, section: string): void;
    }) => (
      <button onClick={() => onOpenSpaceDetail("docs", section)}>
        Docs policy
      </button>
    ),
  }));
  mock.module("./space-git-section", () => ({
    SpaceGitSection: ({
      repositoryPath,
      onStartIdentityEdit,
    }: {
      repositoryPath: string;
      onStartIdentityEdit(): void;
    }) => (
      <div data-repository={repositoryPath}>
        <button onClick={onStartIdentityEdit}>Edit identity</button>
      </div>
    ),
  }));
  mock.module("./identity-section", () => ({
    IdentitySection: () => <div data-identity-detail />,
  }));
  mock.module("./storage-section", () => ({
    StorageSettingsSection: () => <div data-storage />,
    StorageStrategyConfirmDialog: () => null,
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

  test("one real Dialog preserves navigation, pending guards, owner targets, focus and no-project scope", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><button id=trigger data-settings-return-focus>Settings</button><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost" },
    );
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const values: Record<string, unknown> = {
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
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    const { SettingsDialog } = await import("./settings-dialog");
    const { setLocale } = await import("@/paraglide/runtime");
    setLocale("en", { reload: false });
    const root = createRoot(dom.window.document.getElementById("app")!);
    const trigger = dom.window.document.getElementById("trigger")!;
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
    const click = async (label: string) => {
      const button = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((item) => item.textContent === label);
      if (!button) throw new Error(`Missing button ${label}`);
      await act(async () => {
        button.click();
        await tick();
      });
      await act(tick);
    };
    const escape = async () => {
      await act(async () => {
        dom.window.document.activeElement?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await tick();
      });
    };
    const project = (
      section: "general" | "git" | "storage" | "spaces",
      spacePath = "/project",
    ): SettingsDestination => ({ scope: "project", section, spacePath });
    try {
      await draw();
      expect(
        dom.window.document.querySelectorAll('[role="dialog"]').length,
      ).toBe(1);
      expect(
        dom.window.document.querySelector(
          '[data-app-section="git-identity"]',
        ) !== null,
      ).toBe(true);
      expect(
        dom.window.document.querySelector('[role="combobox"]') !== null,
      ).toBe(true);
      expect(
        dom.window.document.querySelector('[data-slot="sidebar-group-label"]')
          ?.textContent,
      ).toBe("Svode");
      const text = dom.window.document.body.textContent ?? "";
      for (const section of [
        "Profile",
        "Appearance",
        "Variables",
        "MCP Integrations",
        "Shortcuts",
        "About",
        "General",
        "Spaces",
        "Git",
        "Storage",
        "Health",
      ])
        expect(text.includes(section)).toBe(true);
      expect(text.includes("AI Agent")).toBe(false);
      const navLabels = Array.from(
        dom.window.document.querySelectorAll(
          '[data-slot="sidebar-menu-button"]',
        ),
      ).map((node) => node.textContent);
      expect(navLabels.slice(0, 3)).toEqual([
        "Profile",
        "Appearance",
        "Variables",
      ]);
      const compactSelect =
        dom.window.document.querySelector<HTMLElement>('[role="combobox"]')!;
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
      const appearanceOption = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>('[role="option"]'),
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
        dom.window.document.querySelector('[data-app-section="appearance"]') !==
          null,
      ).toBe(true);
      await click("Storage");
      expect(dom.window.document.querySelector("[data-storage]") !== null).toBe(
        true,
      );
      pending = true;
      await draw();
      await click("Profile");
      await escape();
      await draw({ scope: "app", section: "appearance" });
      expect(closed).toBe(false);
      expect(dom.window.document.querySelector("[data-storage]") !== null).toBe(
        true,
      );
      expect(cancellations).toBe(0);
      pending = false;
      applying = true;
      await draw();
      await click("Profile");
      expect(dom.window.document.querySelector("[data-storage]") !== null).toBe(
        true,
      );
      applying = false;
      await draw();
      await click("Profile");
      expect(cancellations).toBe(1);
      await draw(project("git", "/project/docs"));
      expect(
        dom.window.document
          .querySelector("[data-repository]")
          ?.getAttribute("data-repository"),
      ).toBe("/project/docs");
      await click("Edit identity");
      await click("Appearance");
      expect(identityCancellations).toBe(1);
      await draw(project("general", "/project/docs"));
      await act(tick);
      const oldLoad = loads.get("/project/docs")!;
      await draw(project("general", "/project/other"));
      await act(tick);
      await act(async () => {
        loads.get("/project/other")!({
          name: "Other canonical",
          description: "",
          icon: "",
        });
        await tick();
      });
      await act(async () => {
        oldLoad({ name: "Stale docs", description: "", icon: "" });
        await tick();
      });
      expect(
        dom.window.document
          .querySelector("[data-general-name]")
          ?.getAttribute("data-general-name"),
      ).toBe("Other canonical");
      await draw(project("git", "/missing"));
      expect(dom.window.document.querySelector("[data-repository]")).toBeNull();
      expect(
        dom.window.document.body.textContent?.includes("no longer available"),
      ).toBe(true);
      await draw(project("spaces"));
      await click("Create space");
      expect(
        dom.window.document.querySelector("[data-create-space]") !== null,
      ).toBe(true);
      await click("Docs general");
      expect(
        dom.window.document.querySelector("[data-create-space]"),
      ).toBeNull();
      await draw({ scope: "app", section: "git-identity" }, true);
      expect(dom.window.document.body.textContent?.includes("CLI Agents")).toBe(
        true,
      );
      expect(dom.window.document.body.textContent?.includes("AI Agent")).toBe(
        true,
      );
      activeRootPath = null;
      await draw(project("git", "/project/docs"));
      expect(
        dom.window.document.querySelectorAll(
          '[data-slot="sidebar-group-label"]',
        ).length,
      ).toBe(1);
      expect(dom.window.document.querySelector("[data-repository]")).toBeNull();
      await click("Profile");
      await escape();
      await act(tick);
      expect(closed).toBe(true);
      expect(dom.window.document.activeElement).toBe(trigger);
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
