import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

const isolatedProcess = process.env.SVODE_REPOSITORY_CONTROL_DOM === "1";

if (!isolatedProcess) {
  test("repository control DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_REPOSITORY_CONTROL_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  let activePath = "/project";
  const space = {
    get path() {
      return activePath;
    },
    activeRootPath: "/project",
  };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: (state: typeof space) => state.path,
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));

  test("one repository control shows the branch, access exceptions and sync state", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const repo: RepoFixture = { ...defaultRepo };
    let access: AccessStatus | "fail" = "writable";
    mockNativeIpc(
      (command, args) => {
        const path = pathArg(args);
        if (
          command === "repository_access_get" ||
          command === "repository_access_activate"
        ) {
          if (access === "fail") throw new Error("Access runtime unavailable");
          return snapshot(path, access, 1);
        }
        return gitCommand(command, repo);
      },
      { shouldMockEvents: true },
    );
    const cases: Array<{
      name: string;
      repo: Partial<RepoFixture>;
      access: AccessStatus | "fail";
      visible: boolean;
      synced?: boolean;
      counters?: string | null;
      indicator?: string | null;
      label?: string[];
    }> = [
      {
        name: "normal",
        repo: {},
        access: "writable",
        visible: true,
        synced: true,
        counters: "",
        indicator: null,
        label: ["Branch main", "Synced"],
      },
      {
        name: "counters",
        repo: { ahead: 2, behind: 1 },
        access: "local",
        visible: true,
        synced: false,
        counters: "1↓2↑",
        indicator: null,
        label: ["1↓ incoming", "2↑ outgoing"],
      },
      {
        name: "unchecked",
        repo: { fetchFails: true },
        access: "writable",
        visible: true,
        synced: false,
        counters: "?↓?↑",
        indicator: null,
      },
      {
        name: "read-only-with-counters",
        repo: { behind: 3 },
        access: "read_only",
        visible: true,
        synced: false,
        counters: "3↓0↑",
        indicator: "read_only",
        label: ["View only", "3↓ incoming"],
      },
      {
        name: "unknown",
        repo: {},
        access: "unknown",
        visible: true,
        synced: true,
        indicator: "unknown",
        label: ["Access not confirmed", "Synced"],
      },
      {
        name: "error",
        repo: {},
        access: "fail",
        visible: true,
        synced: true,
        indicator: "error",
        label: ["Access check failed"],
      },
      {
        name: "local-without-remote",
        repo: { remote: "" },
        access: "local",
        visible: false,
      },
      {
        name: "unknown-without-remote",
        repo: { remote: "" },
        access: "unknown",
        visible: true,
        indicator: "unknown",
      },
    ];

    try {
      for (const scenario of cases) {
        Object.assign(repo, defaultRepo, scenario.repo);
        access = scenario.access;
        activePath = `/state-${scenario.name}`;
        await renderControl(root);

        const control = repositoryControl(dom);
        expect(`${scenario.name}:${Boolean(control)}`).toBe(
          `${scenario.name}:${scenario.visible}`,
        );
        if (!control) continue;
        expect(control.dataset.variant).toBe("ghost");
        expect(control.dataset.size).toBe("sm");
        if (scenario.name === "normal")
          expect(control.className.includes("text-destructive")).toBe(false);
        expect(control.textContent.includes("main")).toBe(true);
        expect(control.textContent.includes("Editing")).toBe(false);
        expect(control.getAttribute("aria-label")?.includes("Write")).toBe(
          false,
        );
        const syncIndicator = control.querySelector(
          "[data-git-sync-indicator]",
        );
        if (repo.remote) {
          expect(Boolean(control.querySelector("[data-git-sync-synced]"))).toBe(
            scenario.synced ?? false,
          );
          if (scenario.counters !== undefined)
            expect(syncIndicator?.textContent).toBe(scenario.counters ?? "");
        } else {
          expect(syncIndicator).toBeNull();
        }
        const indicator = control.querySelector<HTMLElement>(
          "[data-repository-access-indicator]",
        );
        expect(
          `${scenario.name}:${indicator?.dataset.repositoryAccessIndicator ?? null}`,
        ).toBe(`${scenario.name}:${scenario.indicator ?? null}`);
        expect(control.textContent.includes("View only")).toBe(
          scenario.access === "read_only",
        );
        for (const part of scenario.label ?? [])
          expect(
            `${scenario.name}:${control.getAttribute("aria-label")?.includes(part)}`,
          ).toBe(`${scenario.name}:true`);
      }
      expect(dom.window.document.body.textContent.includes("Editing")).toBe(
        false,
      );
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });

  test("the repository dialog carries the exact-target access section and its actions", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    const repo: RepoFixture = { ...defaultRepo };
    const statuses = new Map<string, AccessStatus>();
    const calls: Array<{ command: string; path: string }> = [];
    mockNativeIpc(
      (command, args) => {
        const path = pathArg(args);
        calls.push({ command, path });
        if (
          command === "repository_access_get" ||
          command === "repository_access_activate"
        )
          return snapshot(path, statuses.get(path) ?? "local", calls.length);
        if (command === "repository_access_verify") {
          statuses.set(path, "writable");
          return snapshot(path, "writable", calls.length);
        }
        return gitCommand(command, repo);
      },
      { shouldMockEvents: true },
    );
    const settingsPaths: string[] = [];
    const onOpenRepositorySettings = (path: string) => settingsPaths.push(path);

    try {
      activePath = "/dialog-unknown";
      statuses.set(activePath, "unknown");
      await renderControl(root, { onOpenRepositorySettings });
      await openControl(dom);
      let section = accessSection(dom)!;
      expect(section.dataset.repositoryAccessSectionStatus).toBe("unknown");
      expect(
        section.textContent.includes("Write access is not confirmed"),
      ).toBe(true);
      expect(section.textContent.includes("/dialog-unknown")).toBe(true);
      expect(Boolean(buttonWithText(dialog(dom)!, "Sync now"))).toBe(true);
      await act(async () => {
        buttonWithText(section, "Check access")!.click();
        await settle();
      });
      expect(
        calls.some(
          ({ command, path }) =>
            command === "repository_access_verify" &&
            path === "/dialog-unknown",
        ),
      ).toBe(true);
      section = accessSection(dom)!;
      expect(section.dataset.repositoryAccessSectionStatus).toBe("writable");
      expect(section.textContent.includes("Editing is available")).toBe(true);
      expect(buttonWithText(section, "Check")).toBe(undefined);
      expect(
        repositoryControl(dom)!.querySelector(
          "[data-repository-access-indicator]",
        ),
      ).toBeNull();
      await act(async () => {
        buttonWithText(section, "Open Git settings")!.click();
        await settle();
      });
      expect(settingsPaths).toEqual(["/dialog-unknown"]);
      expect(dialog(dom)).toBeNull();

      activePath = "/dialog-read-only";
      statuses.set(activePath, "read_only");
      await renderControl(root, { onOpenRepositorySettings });
      await openControl(dom);
      section = accessSection(dom)!;
      expect(section.dataset.repositoryAccessSectionStatus).toBe("read_only");
      expect(buttonWithText(section, "Open Git settings")).toBe(undefined);
      await act(async () => {
        buttonWithText(section, "Set up access")!.click();
        await settle();
      });
      expect(settingsPaths).toEqual(["/dialog-unknown", "/dialog-read-only"]);
      expect(dialog(dom)).toBeNull();

      activePath = "/dialog-local-access-only";
      statuses.set(activePath, "unknown");
      repo.remote = "";
      await renderControl(root, { onOpenRepositorySettings });
      await openControl(dom);
      expect(accessSection(dom)?.dataset.repositoryAccessSectionStatus).toBe(
        "unknown",
      );
      expect(buttonWithText(dialog(dom)!, "Sync now")).toBe(undefined);
      expect(dialog(dom)!.textContent.includes("Outgoing commits")).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });

  test("header, Settings and contextual recovery agree through expiry, verify, denial and error in both locales", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { RepositoryAccessSummary } =
      await import("./repository-access-summary");
    const { RepositoryAccessInlineRecovery, RepositoryAccessPrimaryButton } =
      await import("./repository-access-preflight");
    const { useRepositoryAccessPreflight } =
      await import("../hooks/use-repository-access-preflight");
    const { repositoryAccessOwner } =
      await import("../model/repository-access-owner");
    const { setLocale } = await import("@/paraglide/runtime.js");
    const root = createRoot(dom.window.document.getElementById("app")!);
    const repo: RepoFixture = { ...defaultRepo };
    let status: "unknown" | "writable" | "read_only" = "unknown";
    let failure = false;
    let generation = 100;
    let verifyCount = 0;
    let continued = 0;
    let finish!: () => void;
    const result = (path: string) => ({
      ...snapshot(path, status, ++generation),
      reason: status === "unknown" ? "expired" : null,
    });
    mockNativeIpc(
      (command, args) => {
        const path = pathArg(args);
        if (
          command === "repository_access_get" ||
          command === "repository_access_activate"
        ) {
          if (failure) throw new Error("Access runtime unavailable");
          return result(path);
        }
        if (command === "repository_access_verify") {
          verifyCount++;
          return new Promise((resolve) => {
            finish = () => {
              status = "writable";
              resolve(result(path));
            };
          });
        }
        return gitCommand(command, repo);
      },
      { shouldMockEvents: true },
    );
    function Surfaces({ path }: { path: string }) {
      const recovery = useRepositoryAccessPreflight();
      return (
        <TooltipProvider>
          <GitSyncStatusWidget onOpenRepositorySettings={() => undefined} />
          <RepositoryAccessSummary
            repositoryPath={path}
            remoteUrl="https://example.test/repo.git"
            onEditRemote={() => undefined}
          />
          <button
            data-begin
            onClick={() =>
              void recovery.request({
                intentKey: "save",
                intentLabel: "Save",
                placement: "inline",
                continuation: "explicit",
                continue: () => {
                  continued++;
                },
                targets: [
                  {
                    repositoryPath: path,
                    displayName: "Exact target",
                    displayPath: path,
                  },
                ],
              })
            }
          >
            Save
          </button>
          <RepositoryAccessInlineRecovery recovery={recovery} />
          <RepositoryAccessPrimaryButton recovery={recovery} />
        </TooltipProvider>
      );
    }
    const assertStatus = (expected: string) => {
      expect(repositoryControl(dom)!.dataset.repositoryAccessState).toBe(
        expected,
      );
      const surfaces = dom.window.document.querySelectorAll<HTMLElement>(
        "[data-repository-access-status]",
      );
      expect(surfaces.length).toBe(2);
      for (const surface of surfaces)
        expect(surface.dataset.repositoryAccessStatus).toBe(expected);
    };
    try {
      for (const locale of ["en", "ru"] as const) {
        status = "unknown";
        failure = false;
        const path = `/integrated-${locale}`;
        activePath = path;
        await applyBranch(path);
        await setLocale(locale, { reload: false });
        await act(async () => {
          root.render(<Surfaces key={locale} path={path} />);
          await settle();
        });
        await act(async () => {
          dom.window.document
            .querySelector<HTMLButtonElement>("[data-begin]")!
            .click();
          await settle();
        });
        assertStatus("unknown");
        expect(
          repositoryControl(dom)!
            .getAttribute("aria-label")
            ?.includes(
              locale === "ru"
                ? "Доступ не подтверждён"
                : "Access not confirmed",
            ),
        ).toBe(true);
        expect(
          dom.window.document.body.textContent.includes(
            locale === "ru"
              ? "не означает потерю прав"
              : "does not mean you lost write access",
          ),
        ).toBe(true);
        repositoryControl(dom)!.focus();
        await openControl(dom);
        const verify = buttonWithText(
          accessSection(dom)!,
          locale === "ru" ? "Проверить снова" : "Check again",
        )!;
        const before = verifyCount;
        await act(async () => {
          verify.click();
          await settle();
        });
        assertStatus("checking");
        expect(verifyCount).toBe(before + 1);
        expect(repositoryControl(dom)!.getAttribute("aria-busy")).toBe("true");
        expect(
          repositoryControl(dom)!.querySelector<HTMLElement>(
            "[data-repository-access-indicator]",
          )?.dataset.repositoryAccessIndicator,
        ).toBe("checking");
        await act(async () => {
          finish();
          await settle();
        });
        expect(repositoryControl(dom)!.dataset.repositoryAccessState).toBe(
          "writable",
        );
        expect(
          Boolean(
            dom.window.document.querySelector("[data-repository-access-ready]"),
          ),
        ).toBe(true);
        expect(continued).toBe(0);
        await act(async () => {
          dialog(dom)!.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
          await settle();
        });
        expect(dialog(dom)).toBeNull();
        expect(
          dom.window.document.activeElement === repositoryControl(dom),
        ).toBe(true);
        status = "read_only";
        await act(async () => {
          await repositoryAccessOwner.refresh(path);
        });
        assertStatus("read_only");
        expect(
          repositoryControl(dom)!
            .getAttribute("aria-label")
            ?.includes(locale === "ru" ? "Только просмотр" : "View only"),
        ).toBe(true);
        failure = true;
        await act(async () => {
          await repositoryAccessOwner.refresh(path);
        });
        assertStatus("error");
        expect(
          repositoryControl(dom)!
            .getAttribute("aria-label")
            ?.includes(
              locale === "ru"
                ? "Ошибка проверки доступа"
                : "Access check failed",
            ),
        ).toBe(true);
      }
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      repositoryAccessOwner.dispose();
      await setLocale("en", { reload: false });
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });

  test("only the content surface activates access checks; other screens read passively", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { RepositoryAccessSummary, RepositoryAccessBadge } =
      await import("./repository-access-summary");
    const { repositoryAccessOwner } =
      await import("../model/repository-access-owner");
    const { emit } = await import("@/platform/native/events");
    const root = createRoot(dom.window.document.getElementById("app")!);
    const repo: RepoFixture = { ...defaultRepo };
    let status: AccessStatus | "checking" = "unknown";
    let reason: string | null = "not_checked";
    let generation = 1000;
    let consumed = false;
    let probes = 0;
    let activations = 0;
    let finish!: () => void;
    const result = (path: string) => ({
      ...snapshot(path, status, ++generation),
      reason,
    });
    mockNativeIpc(
      (command, args) => {
        const path = pathArg(args);
        if (command === "repository_access_get") return result(path);
        if (command === "repository_access_activate") {
          expect(path).toBe("/automatic");
          activations++;
          if (consumed) return result(path);
          consumed = true;
          probes++;
          status = "checking";
          void emit("git:repository-access-changed", {
            repositoryId: "repo:/automatic",
          });
          return new Promise((resolve) => {
            finish = () => {
              status = "unknown";
              reason = "offline_or_timeout";
              resolve(result(path));
            };
          });
        }
        if (command === "repository_access_verify") {
          status = "writable";
          reason = null;
          return result(path);
        }
        return gitCommand(command, repo);
      },
      { shouldMockEvents: true },
    );
    const render = (activateAccess: boolean) =>
      act(async () => {
        root.render(
          <TooltipProvider>
            <textarea defaultValue="Unsaved draft" />
            <GitSyncStatusWidget activateAccess={activateAccess} />
            <RepositoryAccessBadge repositoryPath="/sibling" />
          </TooltipProvider>,
        );
        await settle();
      });
    try {
      activePath = "/automatic";
      await applyBranch(activePath);
      await render(false);
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await settle();
      });
      expect(activations).toBe(0);
      expect(
        repositoryControl(dom)!.querySelector<HTMLElement>(
          "[data-repository-access-indicator]",
        )?.dataset.repositoryAccessIndicator,
      ).toBe("unknown");

      await render(true);
      expect(repositoryControl(dom)!.dataset.repositoryAccessState).toBe(
        "checking",
      );
      expect(probes).toBe(1);
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        finish();
        await settle();
      });
      expect(repositoryControl(dom)!.dataset.repositoryAccessState).toBe(
        "unknown",
      );
      const beforeHidden = activations;
      await act(async () => {
        Object.defineProperty(dom.window.document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        dom.window.document.dispatchEvent(
          new dom.window.Event("visibilitychange"),
        );
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await settle();
      });
      expect(activations).toBe(beforeHidden);
      await act(async () => {
        Object.defineProperty(dom.window.document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        dom.window.document.dispatchEvent(
          new dom.window.Event("visibilitychange"),
        );
        await settle();
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await settle();
      });
      expect(probes).toBe(1);
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      expect(dom.window.document.querySelector("textarea")?.value).toBe(
        "Unsaved draft",
      );

      const activationsBeforeLeaving = activations;
      await render(false);
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await settle();
      });
      expect(activations).toBe(activationsBeforeLeaving);
      await act(async () => {
        await repositoryAccessOwner.verify("/automatic");
      });
      expect(repositoryControl(dom)!.dataset.repositoryAccessState).toBe(
        "writable",
      );
      expect(
        repositoryControl(dom)!.querySelector(
          "[data-repository-access-indicator]",
        ),
      ).toBeNull();

      // A Settings host activates by itself, independently of the header.
      await act(async () => {
        root.render(
          <RepositoryAccessSummary
            repositoryPath="/automatic"
            remoteUrl="https://example.test/remote.git"
            onEditRemote={() => undefined}
          />,
        );
        await settle();
      });
      expect(activations).toBe(activationsBeforeLeaving + 1);
    } finally {
      await act(async () => {
        root.unmount();
        await settle();
      });
      repositoryAccessOwner.dispose();
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });

  async function renderControl(
    root: Root,
    props: ComponentProps<
      typeof import("./git-sync-status-widget").GitSyncStatusWidget
    > = {},
  ) {
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    await applyBranch(activePath);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <GitSyncStatusWidget key={activePath} {...props} />
        </TooltipProvider>,
      );
      await settle();
    });
  }
}

interface RepoFixture {
  remote: string;
  ahead: number;
  behind: number;
  fetchFails: boolean;
}

const defaultRepo: RepoFixture = {
  remote: "https://example.test/project.git",
  ahead: 0,
  behind: 0,
  fetchFails: false,
};

async function applyBranch(path: string) {
  const { useGitStore } = await import("../model/git-store");
  useGitStore.getState().applyStatus(path, {
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [],
    hasStaged: false,
    hasUnstaged: false,
    hasConflicts: false,
    tracking: "origin/main",
  });
}

function gitCommand(command: string, repo: RepoFixture) {
  if (command === "git_get_user_policy") return { autoSync: false };
  if (command === "git_get_remote") return repo.remote;
  if (command === "git_publication_status") return null;
  if (command === "git_fetch_status") {
    if (repo.fetchFails) throw "git fetch failed: connection timed out";
    return {
      branch: "main",
      ahead: repo.ahead,
      behind: repo.behind,
      files: [],
    };
  }
  if (command === "git_unpushed_commits") return [];
  throw new Error(`Unexpected command: ${command}`);
}

type AccessStatus = "local" | "writable" | "unknown" | "read_only" | "checking";

function snapshot(path: string, status: AccessStatus, generation: number) {
  return {
    checkedAt: null,
    expiresAt: null,
    generation,
    lastKnownStatus: null,
    reason: status === "unknown" ? "not_checked" : null,
    repositoryId: `repo:${path}`,
    status,
  };
}

function pathArg(args: unknown) {
  return String((args as { spacePath?: string } | undefined)?.spacePath ?? "");
}

function repositoryControl(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLButtonElement>(
    "[data-repository-control]",
  );
}

function dialog(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
}

function accessSection(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLElement>(
    "[data-repository-access-section]",
  );
}

function buttonWithText(container: HTMLElement, text: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.trim() === text);
}

async function openControl(dom: JSDOM) {
  await act(async () => {
    repositoryControl(dom)!.click();
    await settle();
  });
  expect(Boolean(dialog(dom))).toBe(true);
}

function settle() {
  return new Promise<void>((resolve) => setTimeout(resolve, 40));
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
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
