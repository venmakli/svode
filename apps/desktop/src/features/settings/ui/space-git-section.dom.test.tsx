import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import * as m from "@/paraglide/messages.js";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type {
  GitPolicyField,
  SpaceSettingsGit,
} from "../hooks/use-space-settings-git";
import type { SpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import { SpaceGitSection } from "./space-git-section";

const isolatedProcess = process.env.SVODE_REPOSITORY_ACCESS_DOM_PROCESS === "1";

const noop = () => undefined;

function gitFixture(
  overrides: Partial<SpaceSettingsGit> = {},
): SpaceSettingsGit {
  return {
    loaded: true,
    gitType: "submodule",
    submoduleUrl: "https://example.test/archive.git",
    remoteUrl: "https://example.test/archive.git",
    savedRemoteUrl: "https://example.test/archive.git",
    branch: "main",
    autoSync: false,
    autoCommitStructural: true,
    autoCommitSystem: false,
    policyPending: new Set<GitPolicyField>(),
    pendingRemote: null,
    applyingRemote: false,
    remoteUpdateResult: null,
    setRemoteUrl: noop,
    handleRemoteBlur: noop,
    handlePolicyChange: async () => undefined,
    cancelPendingRemote: noop,
    confirmPendingRemote: async () => undefined,
    ...overrides,
  };
}

function identityFixture(
  overrides: Partial<SpaceSettingsIdentity> = {},
): SpaceSettingsIdentity {
  return {
    repoIdentity: null,
    identityLoaded: true,
    identityName: "",
    identityEmail: "",
    identityFormError: null,
    savingIdentity: false,
    identityEditing: false,
    canResetIdentity: false,
    fanoutEnabled: false,
    fanoutPreview: [],
    fanoutSelected: {},
    setIdentityName: noop,
    setIdentityEmail: noop,
    handleStartIdentityEdit: noop,
    handleCancelIdentityEdit: noop,
    setFanoutEnabled: noop,
    setFanoutSelected: noop,
    handleSaveIdentity: async () => undefined,
    handleResetIdentity: async () => undefined,
    ...overrides,
  };
}

if (!isolatedProcess) {
  test("repository access Settings DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_REPOSITORY_ACCESS_DOM_PROCESS: "1",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  test("owner Git groups keep access, connection, automation and author in rows of one owner", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const calls: string[] = [];
    mockNativeIpc(
      (command) => {
        calls.push(command);
        if (
          command === "repository_access_get" ||
          command === "repository_access_activate"
        ) {
          return {
            checkedAt: null,
            expiresAt: null,
            generation: 4,
            lastKnownStatus: null,
            reason: null,
            repositoryId: "repo-submodule",
            status: "local",
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    const document = dom.window.document;
    const longPath =
      "/Users/test/Projects/a-very-long-project-name/spaces/a-very-long-submodule-name";
    const groups = () =>
      Array.from(document.querySelectorAll<HTMLElement>("#app > section")).map(
        (group) => group.querySelector("h3")?.textContent,
      );
    const group = (title: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("section")).find(
        (section) => section.querySelector("h3")?.textContent === title,
      )!;
    const inputFor = (label: string) =>
      Array.from(document.querySelectorAll("label"))
        .filter((node) => node.htmlFor !== "" && node.textContent === label)
        .map((node) => document.getElementById(node.htmlFor)) as HTMLElement[];

    try {
      const policyChanges: [GitPolicyField, boolean][] = [];
      await act(async () => {
        root.render(
          <SpaceGitSection
            spacePath={longPath}
            isRoot={false}
            projectName="Knowledge Base"
            git={gitFixture({
              remoteUpdateResult: {
                localRemoteUpdated: true,
                trackedReconciliation: {
                  status: "pending_repository_access",
                  repositoryId: "repo-parent",
                  accessStatus: "unknown",
                  accessReason: "not_checked",
                },
              },
              policyPending: new Set<GitPolicyField>(["autoCommitSystem"]),
              handlePolicyChange: async (field, value) => {
                policyChanges.push([field, value]);
              },
            })}
            identity={identityFixture()}
          />,
        );
        await settle();
      });

      expect(groups()).toEqual([
        "Repository access",
        "Connection",
        "Automation on this device",
        "Commit author",
      ]);

      // Access is the content of its group's card: no heading, owner or path
      // of its own; exact settings activate once and never probe.
      const access = document.querySelector<HTMLElement>(
        "[data-repository-access-summary]",
      )!;
      expect(access.closest("section")).toBe(group("Repository access"));
      expect(access.closest("[data-slot=card]") === null).toBe(false);
      expect(access.dataset.repositoryAccessStatus).toBe("local");
      expect(access.querySelector("h2, h3")).toBeNull();
      expect(access.textContent?.includes(longPath)).toBe(false);
      expect(
        Array.from(access.querySelectorAll("button")).some(
          (button) =>
            button.textContent?.trim() === m.git_access_action_check_again(),
        ),
      ).toBe(false);
      expect(calls.includes("repository_access_get")).toBe(true);
      expect(
        calls.filter((command) => command === "repository_access_activate"),
      ).toEqual(["repository_access_activate"]);
      expect(calls.includes("repository_access_verify")).toBe(false);

      // Remote URL is a full-width field; the submodule address and the
      // branch are read-only rows; the reconciliation notice sits above the
      // card.
      const [remote] = inputFor("Remote URL");
      expect(remote?.tagName).toBe("INPUT");
      expect(
        remote?.closest("[data-slot=field]")?.getAttribute("data-orientation"),
      ).toBe("vertical");
      const connection = group("Connection");
      expect(connection.textContent?.includes("Submodule URL")).toBe(true);
      expect(
        connection.textContent?.includes(
          "The address the “Knowledge Base” project uses to include this space.",
        ),
      ).toBe(true);
      expect(connection.textContent?.includes("Branch")).toBe(true);
      expect(
        connection
          .querySelector("[data-slot=alert]")
          ?.textContent?.includes(m.git_remote_reconciliation_pending_title()),
      ).toBe(true);
      expect(
        connection
          .querySelector("[data-slot=card]")
          ?.querySelector("[data-slot=alert]") ?? null,
      ).toBeNull();

      // Switches apply at once; a pending one keeps focus, shows progress and
      // ignores a second change.
      const [autoSync] = inputFor("Sync after commit");
      const [structural] = inputFor("Commit structural changes");
      const [system] = inputFor("Commit system settings");
      expect(autoSync?.getAttribute("role")).toBe("switch");
      expect(autoSync?.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        structural!.click();
        await settle();
      });
      expect(policyChanges).toEqual([["autoCommitStructural", false]]);
      expect(system?.getAttribute("aria-disabled")).toBe("true");
      expect(system?.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        system!.click();
        await settle();
      });
      expect(policyChanges.length).toBe(1);

      // Without a saved remote, sync is unavailable and the row says why.
      await act(async () => {
        root.render(
          <SpaceGitSection
            spacePath={longPath}
            isRoot={false}
            projectName="Knowledge Base"
            git={gitFixture({ remoteUrl: "", savedRemoteUrl: "" })}
            identity={identityFixture()}
          />,
        );
        await settle();
      });
      expect(inputFor("Sync after commit")[0]?.hasAttribute("disabled")).toBe(
        true,
      );
      expect(
        group("Automation on this device").textContent?.includes(
          m.settings_git_auto_sync_no_remote(),
        ),
      ).toBe(true);

      // Loading keeps skeleton rows in each card instead of empty values.
      await act(async () => {
        root.render(
          <SpaceGitSection
            spacePath={longPath}
            isRoot={false}
            projectName="Knowledge Base"
            git={gitFixture({ loaded: false })}
            identity={identityFixture({ identityLoaded: false })}
          />,
        );
        await settle();
      });
      expect(inputFor("Remote URL")).toEqual([]);
      expect(inputFor("Sync after commit")).toEqual([]);
      expect(
        group("Commit author").querySelector("[data-slot=skeleton]") === null,
      ).toBe(false);
      expect(
        group("Commit author").querySelector("[data-slot=alert]"),
      ).toBeNull();

      // Two owners on one page keep their own fields.
      await act(async () => {
        root.render(
          <>
            <SpaceGitSection
              spacePath="/project"
              isRoot
              projectName="Knowledge Base"
              git={gitFixture({ gitType: null, submoduleUrl: null })}
              identity={identityFixture()}
            />
            <SpaceGitSection
              spacePath={longPath}
              isRoot={false}
              projectName="Knowledge Base"
              git={gitFixture()}
              identity={identityFixture()}
            />
          </>,
        );
        await settle();
      });
      const [projectRemote, spaceRemote] = inputFor("Remote URL");
      expect(projectRemote?.tagName).toBe("INPUT");
      expect(spaceRemote?.tagName).toBe("INPUT");
      expect(projectRemote === spaceRemote).toBe(false);
      expect(
        document.querySelectorAll(
          `button[aria-label$="${m.settings_git_identity_set_project()}"]`,
        ).length,
      ).toBe(1);
      expect(
        document.querySelectorAll(
          `button[aria-label$="${m.settings_git_identity_set_repository()}"]`,
        ).length,
      ).toBe(1);
      // Without an author the callout above the card explains it once and
      // the row names the state without a second badge.
      const missingAuthor = group("Commit author");
      expect(
        missingAuthor
          .querySelector("[data-slot=alert]")
          ?.textContent?.includes(m.settings_git_identity_missing_title()),
      ).toBe(true);
      const authorCard = missingAuthor.querySelector("[data-slot=card]")!;
      expect(authorCard.textContent?.includes("Not configured")).toBe(true);
      expect(authorCard.querySelector("[data-slot=badge]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("commit author row opens its editor in place and returns focus to the row", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    mockNativeIpc(
      () => ({
        checkedAt: null,
        expiresAt: null,
        generation: 1,
        lastKnownStatus: null,
        reason: null,
        repositoryId: "repo",
        status: "local",
      }),
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    const document = dom.window.document;
    let resets = 0;
    let fanout: Record<string, boolean> = {};

    function Author() {
      const [editing, setEditing] = useState(false);
      const [fanoutEnabled, setFanoutEnabled] = useState(false);
      return (
        <SpaceGitSection
          spacePath="/project"
          isRoot
          projectName="Knowledge Base"
          git={gitFixture({ gitType: null, submoduleUrl: null })}
          identity={identityFixture({
            repoIdentity: {
              effective: { name: "Ada Lovelace", email: "ada@example.test" },
              local: { name: "Ada Lovelace", email: "ada@example.test" },
              source: "local",
            },
            identityName: "Ada Lovelace",
            identityEmail: "ada@example.test",
            identityEditing: editing,
            canResetIdentity: true,
            fanoutEnabled,
            fanoutPreview: [
              {
                spacePath: "/project/docs",
                spaceName: "Docs",
                currentLocal: null,
                currentEffective: {
                  name: "Global Author",
                  email: "global@example.test",
                },
                willReplace: false,
              },
            ],
            fanoutSelected: { "/project/docs": true },
            handleStartIdentityEdit: () => setEditing(true),
            handleCancelIdentityEdit: () => setEditing(false),
            setFanoutEnabled: (value) => setFanoutEnabled(value),
            setFanoutSelected: (next) => {
              fanout = next as Record<string, boolean>;
            },
            handleResetIdentity: async () => {
              resets++;
              setEditing(false);
            },
          })}
        />
      );
    }
    const button = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (node) => node.textContent === label,
      )!;

    try {
      await act(async () => {
        root.render(<Author />);
        await settle();
      });
      const author = Array.from(document.querySelectorAll("section")).find(
        (section) =>
          section.querySelector("h3")?.textContent === "Commit author",
      )!;
      expect(author.textContent?.includes("Ada Lovelace")).toBe(true);
      expect(author.textContent?.includes("ada@example.test")).toBe(true);
      expect(
        author.querySelector('[data-slot="avatar-fallback"]') === null,
      ).toBe(false);
      const edit = author.querySelector<HTMLButtonElement>(
        'button[aria-label="Ada Lovelace: Edit"]',
      )!;
      await act(async () => {
        edit.click();
        await settle();
      });

      const form = author.querySelector("form")!;
      expect(form.getAttribute("aria-label")).toBe("Commit author");
      expect(document.activeElement?.id.endsWith("-name")).toBe(true);
      expect(
        form.querySelectorAll('input:not([aria-hidden="true"])').length,
      ).toBe(2);
      const actions = Array.from(
        form.querySelectorAll<HTMLButtonElement>("button:not([role])"),
      ).map((node) => node.textContent);
      expect(actions).toEqual(["Reset to global", "Cancel", "Save"]);
      expect(button("Reset to global").dataset.variant).toBe("destructive");

      // The nested repositories list appears with the switch.
      const fanoutSwitch = Array.from(form.querySelectorAll("label"))
        .filter(
          (label) =>
            label.textContent === m.settings_git_identity_nested_checkbox(),
        )
        .map((label) => document.getElementById(label.htmlFor))[0]!;
      await act(async () => {
        fanoutSwitch.click();
        await settle();
      });
      const repositories = form.querySelector('[role="group"][aria-label]')!;
      expect(repositories.textContent?.includes("Docs")).toBe(true);
      expect(
        repositories.textContent?.includes(
          "Current: Global Author <global@example.test>",
        ),
      ).toBe(true);
      expect(repositories.querySelector("[data-slot=card]")).toBeNull();
      await act(async () => {
        repositories
          .querySelector<HTMLButtonElement>('[role="checkbox"]')!
          .click();
        await settle();
      });
      expect(fanout).toEqual({ "/project/docs": false });

      await act(async () => {
        button("Cancel").click();
        await settle();
      });
      expect(author.querySelector("form")).toBeNull();
      expect(document.activeElement).toBe(
        author.querySelector('button[aria-label="Ada Lovelace: Edit"]'),
      );

      await act(async () => {
        author
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Ada Lovelace: Edit"]',
          )!
          .click();
        await settle();
      });
      await act(async () => {
        button("Reset to global").click();
        await settle();
      });
      expect(resets).toBe(1);
      expect(document.activeElement).toBe(
        author.querySelector('button[aria-label="Ada Lovelace: Edit"]'),
      );
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
      await setLocale(originalLocale, { reload: false });
    }
  });
}

function createDom() {
  const dom = new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  // React's input event fallback in jsdom listens through attachEvent.
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
  return dom;
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    PointerEvent: dom.window.MouseEvent,
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
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
