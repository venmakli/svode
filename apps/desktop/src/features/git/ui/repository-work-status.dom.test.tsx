import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

const isolatedProcess = process.env.SVODE_REPOSITORY_WORK_STATUS_DOM === "1";

if (!isolatedProcess) {
  test("repository work status DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_REPOSITORY_WORK_STATUS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  test("repository work status keeps one compact exact-target recovery control", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const calls: Array<{ command: string; spacePath: string }> = [];
    let rootStatus: AccessStatus = "local";
    let childStatus: AccessStatus = "unknown";
    let generation = 0;
    mockNativeIpc(
      (command, args) => {
        const spacePath = String(
          (args as { spacePath?: string } | undefined)?.spacePath ?? "",
        );
        calls.push({ command, spacePath });
        generation += 1;
        if (
          command === "repository_access_get" ||
          command === "repository_access_activate"
        ) {
          const status = spacePath === "/child" ? childStatus : rootStatus;
          return snapshot(spacePath, status, generation);
        }
        if (command === "repository_access_verify") {
          if (spacePath === "/child") childStatus = "writable";
          else rootStatus = "writable";
          return snapshot(spacePath, "writable", generation);
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { RepositoryWorkStatus } = await import("./repository-work-status");
    const settingsPaths: string[] = [];
    const root = createRoot(dom.window.document.getElementById("app")!);

    try {
      await act(async () => {
        root.render(
          <RepositoryWorkStatus
            contextName="Project"
            displayPath="/project"
            repositoryPath="/project"
            onOpenRepositorySettings={(path) => settingsPaths.push(path)}
          />,
        );
        await nextFrame(dom);
        await nextFrame(dom);
      });

      const rootTrigger = workStatusTrigger(dom);
      expect(rootTrigger.dataset.repositoryWorkStatusState).toBe("local");
      expect(rootTrigger.getAttribute("aria-label")?.includes("Project")).toBe(
        true,
      );
      expect(rootTrigger.textContent.includes("Editing available")).toBe(true);
      expect(
        calls.some(({ command }) => command === "repository_access_verify"),
      ).toBe(false);

      await act(async () => {
        rootTrigger.focus();
        rootTrigger.click();
        await nextFrame(dom);
      });
      const rootPopover = popover(dom)!;
      expect(rootPopover.textContent.includes("Editing is available")).toBe(
        true,
      );
      expect(rootPopover.textContent.includes("/project")).toBe(true);
      const settingsButton = Array.from(
        rootPopover.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes("Open Git settings"))!;
      await act(async () => settingsButton.click());
      expect(settingsPaths).toEqual(["/project"]);
      await act(async () => {
        rootPopover.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });

      await act(async () => {
        root.render(
          <RepositoryWorkStatus
            contextName="Independent Space"
            displayPath="child"
            repositoryPath="/child"
            onOpenRepositorySettings={(path) => settingsPaths.push(path)}
          />,
        );
        await nextFrame(dom);
        await nextFrame(dom);
      });

      const childTrigger = workStatusTrigger(dom);
      expect(childTrigger.dataset.repositoryWorkStatusState).toBe("unknown");
      expect(childTrigger.textContent.includes("Access not confirmed")).toBe(
        true,
      );
      expect(
        childTrigger.getAttribute("aria-label")?.includes("Independent Space"),
      ).toBe(true);
      await act(async () => {
        childTrigger.click();
        await nextFrame(dom);
      });
      const childPopover = popover(dom);
      expect(Boolean(childPopover)).toBe(true);
      const verifyButton = Array.from(
        childPopover!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes("Check access"))!;
      await act(async () => {
        verifyButton.click();
        await nextFrame(dom);
        await nextFrame(dom);
      });

      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
        "writable",
      );
      expect(
        calls.some(
          ({ command, spacePath }) =>
            command === "repository_access_verify" && spacePath === "/child",
        ),
      ).toBe(true);
      await act(async () => {
        popover(dom)?.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });

  test("header, Settings and contextual recovery agree through expiry, verify, denial and error in both locales", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { RepositoryWorkStatus } = await import("./repository-work-status");
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
        const path = String((args as { spacePath?: string })?.spacePath);
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
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    function Surfaces({ path }: { path: string }) {
      const recovery = useRepositoryAccessPreflight();
      return (
        <>
          <RepositoryWorkStatus
            contextName="Long repository name"
            displayPath={path}
            repositoryPath={path}
            onOpenRepositorySettings={() => undefined}
          />
          <RepositoryAccessSummary
            ownerKind="independent"
            ownerName="Long repository name"
            displayPath={path}
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
        </>
      );
    }
    const assertStatus = (expected: string) => {
      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
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
        await setLocale(locale, { reload: false });
        await act(async () => {
          root.render(<Surfaces key={locale} path={path} />);
          await nextFrame(dom);
        });
        await act(async () => {
          dom.window.document
            .querySelector<HTMLButtonElement>("[data-begin]")!
            .click();
          await nextFrame(dom);
        });
        assertStatus("unknown");
        expect(
          workStatusTrigger(dom)
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
        await act(async () => {
          workStatusTrigger(dom).click();
          await nextFrame(dom);
        });
        const verify = Array.from(
          popover(dom)!.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) =>
          button.textContent?.includes(
            locale === "ru" ? "Проверить снова" : "Check again",
          ),
        )!;
        const before = verifyCount;
        await act(async () => {
          verify.click();
          await nextFrame(dom);
        });
        assertStatus("checking");
        expect(verifyCount).toBe(before + 1);
        expect(workStatusTrigger(dom).getAttribute("aria-busy")).toBe("true");
        await act(async () => {
          finish();
          await nextFrame(dom);
        });
        expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
          "writable",
        );
        expect(
          Boolean(
            dom.window.document.querySelector("[data-repository-access-ready]"),
          ),
        ).toBe(true);
        expect(continued).toBe(0);
        await act(async () => {
          popover(dom)!.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
          await nextFrame(dom);
        });
        expect(dom.window.document.activeElement).toBe(workStatusTrigger(dom));
        status = "read_only";
        await act(async () => {
          await repositoryAccessOwner.refresh(path);
        });
        assertStatus("read_only");
        expect(
          workStatusTrigger(dom)
            .getAttribute("aria-label")
            ?.includes(locale === "ru" ? "Только просмотр" : "View only"),
        ).toBe(true);
        failure = true;
        await act(async () => {
          await repositoryAccessOwner.refresh(path);
        });
        assertStatus("error");
        expect(
          workStatusTrigger(dom)
            .getAttribute("aria-label")
            ?.includes(
              locale === "ru"
                ? "Ошибка проверки доступа"
                : "Access check failed",
            ),
        ).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      repositoryAccessOwner.dispose();
      await setLocale("en", { reload: false });
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });
  test("automatic activation shares checking, preserves draft and stays silent after failure", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { RepositoryWorkStatus } = await import("./repository-work-status");
    const { RepositoryAccessSummary, RepositoryAccessBadge } =
      await import("./repository-access-summary");
    const { repositoryAccessOwner } =
      await import("../model/repository-access-owner");
    const { emit } = await import("@/platform/native/events");
    const root = createRoot(dom.window.document.getElementById("app")!);
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
        const path = String((args as { spacePath?: string })?.spacePath);
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
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    try {
      await act(async () => {
        root.render(
          <>
            <textarea defaultValue="Unsaved draft" />
            <RepositoryWorkStatus
              contextName="Auto"
              displayPath="/automatic"
              repositoryPath="/automatic"
            />
            <RepositoryAccessSummary
              ownerKind="independent"
              ownerName="Auto"
              displayPath="/automatic"
              repositoryPath="/automatic"
              remoteUrl="https://example.test/remote.git"
              onEditRemote={() => undefined}
            />
            <RepositoryAccessBadge
              ownerKind="independent"
              repositoryPath="/sibling"
            />
          </>,
        );
        await nextFrame(dom);
        await nextFrame(dom);
      });
      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
        "checking",
      );
      expect(
        dom.window.document
          .querySelector("[data-repository-access-summary]")
          ?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(probes).toBe(1);
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        finish();
        await nextFrame(dom);
      });
      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
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
        await nextFrame(dom);
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
        await nextFrame(dom);
        dom.window.dispatchEvent(new dom.window.Event("focus"));
        await nextFrame(dom);
      });
      expect(probes).toBe(1);
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      expect(dom.window.document.querySelector("textarea")?.value).toBe(
        "Unsaved draft",
      );
      await act(async () => {
        await repositoryAccessOwner.verify("/automatic");
      });
      expect(workStatusTrigger(dom).dataset.repositoryWorkStatusState).toBe(
        "writable",
      );
    } finally {
      await act(async () => root.unmount());
      repositoryAccessOwner.dispose();
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    }
  });
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

function workStatusTrigger(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLButtonElement>(
    "[data-repository-work-status]",
  )!;
}

function popover(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLElement>(
    '[data-slot="popover-content"]',
  );
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextFrame(dom: JSDOM) {
  return new Promise<void>((resolve) => {
    dom.window.setTimeout(
      () => dom.window.requestAnimationFrame(() => resolve()),
      0,
    );
  });
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
