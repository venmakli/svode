import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import * as m from "@/paraglide/messages.js";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { SpaceGitSection } from "./space-git-section";
import { ProjectSpacePolicyList } from "./space-settings-spaces-section";

const isolatedProcess = process.env.SVODE_REPOSITORY_ACCESS_DOM_PROCESS === "1";

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
  test("exact submodule capability leads Settings without probing and preserves partial recovery", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const calls: string[] = [];
    mockNativeIpc(
      (command) => {
        calls.push(command);
        if (command === "repository_access_get") {
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
    const longPath =
      "/Users/test/Projects/a-very-long-project-name/spaces/a-very-long-submodule-name";

    try {
      await act(async () => {
        root.render(
          <SpaceGitSection
            gitType="submodule"
            repositoryAccessOwnerKind="submodule"
            repositoryPath={longPath}
            repositoryDisplayPath={longPath}
            repositoryOwnerName="Long-lived research archive"
            activeRootName="Knowledge Base"
            scopeName="Long-lived research archive"
            isRoot={false}
            submoduleUrl="https://example.test/archive.git"
            remoteUrl="https://example.test/archive.git"
            branch="main"
            autoSync={false}
            autoCommitStructural={false}
            autoCommitSystem={false}
            repoIdentity={null}
            identityName=""
            identityEmail=""
            identityFormError={null}
            savingIdentity={false}
            canResetIdentity={false}
            remoteUpdateResult={{
              localRemoteUpdated: true,
              trackedReconciliation: {
                status: "pending_repository_access",
                repositoryId: "repo-parent",
                accessStatus: "unknown",
                accessReason: "not_checked",
              },
            }}
            fanoutEnabled={false}
            fanoutPreview={[]}
            fanoutSelected={{}}
            onRemoteChange={() => undefined}
            onRemoteBlur={() => undefined}
            onAutoSyncChange={() => undefined}
            onAutoCommitStructuralChange={() => undefined}
            onAutoCommitSystemChange={() => undefined}
            onIdentityNameChange={() => undefined}
            onIdentityEmailChange={() => undefined}
            onStartIdentityEdit={() => undefined}
            onCancelIdentityEdit={() => undefined}
            onSaveIdentity={() => undefined}
            onResetIdentity={() => undefined}
            onFanoutEnabledChange={() => undefined}
            onFanoutSelectedChange={() => undefined}
            onEditRemote={() => undefined}
          />,
        );
        await settle();
      });

      const section = dom.window.document.querySelector<HTMLElement>(
        "[data-repository-access-summary]",
      );
      expect(section).toBe(
        (dom.window.document.querySelector("#app > div")?.firstElementChild ??
          null) as HTMLElement | null,
      );
      expect(section?.dataset.repositoryAccessStatus).toBe("local");
      expect(
        section?.textContent?.includes("Long-lived research archive"),
      ).toBe(true);
      expect(section?.querySelector(`[title="${longPath}"]`) === null).toBe(
        false,
      );
      expect(
        Array.from(section?.querySelectorAll("button") ?? []).some(
          (button) =>
            button.textContent?.trim() === m.git_access_action_check_again(),
        ),
      ).toBe(false);
      expect(dom.window.document.getElementById("ws-git-remote") === null).toBe(
        false,
      );
      expect(
        dom.window.document.body.textContent?.includes(
          m.git_remote_reconciliation_pending_title(),
        ),
      ).toBe(true);
      expect(
        calls.filter((command) => command === "repository_access_get"),
      ).toEqual(["repository_access_get"]);
      expect(calls.includes("repository_access_verify")).toBe(false);

      await setLocale("ru", { reload: false });
      const rowPath =
        "/Users/test/Projects/knowledge-base/spaces/очень-длинное-название-пространства";
      await act(async () => {
        root.render(
          <ProjectSpacePolicyList
            projectPath="/Users/test/Projects/knowledge-base"
            spaces={[
              {
                id: "long-space",
                name: "Очень длинное название пространства разработки",
                icon: "👍",
                description: "",
                path: rowPath,
                hasSpaces: false,
                hasSchema: false,
                lastOpened: null,
                status: "ready",
                lfsState: "n/a",
              },
            ]}
            gitTypes={{ "long-space": "independent" }}
            section="git"
            onOpenSpaceDetail={() => undefined}
          />,
        );
        await settle();
      });

      const row = dom.window.document.querySelector<HTMLElement>(
        "[data-space-summary-row]",
      );
      const identity = row?.querySelector<HTMLElement>(
        "[data-space-row-identity]",
      );
      const access = row?.querySelector<HTMLElement>(
        "[data-space-row-repository-access]",
      );
      const action = row?.querySelector<HTMLElement>("[data-space-row-action]");
      expect(row?.className.includes("grid-cols-[minmax(0,1fr)_auto]")).toBe(
        true,
      );
      expect(identity?.contains(access ?? null)).toBe(false);
      expect(access === null || action === null).toBe(false);
      expect(row?.getAttribute("aria-label")?.includes(rowPath)).toBe(true);
      expect(
        identity
          ?.querySelector<HTMLElement>(
            `[title="Очень длинное название пространства разработки"]`,
          )
          ?.className.includes("break-words"),
      ).toBe(true);
      expect(
        access
          ?.querySelector<HTMLElement>("[data-repository-access-row-status]")
          ?.className.includes("max-w-full"),
      ).toBe(true);
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
  return new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
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
