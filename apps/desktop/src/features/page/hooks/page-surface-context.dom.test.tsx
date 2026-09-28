import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

// Radix portals pick their layout effect when first imported, so the
// confirmation dialog needs a process that loads it after the DOM exists.
const isolated = process.env.SVODE_PAGE_SESSION_DOM === "1";
const domTest: typeof test = isolated ? test : () => undefined;
if (!isolated) {
  test("Page session DOM scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_SESSION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 30000);
}

domTest("Page derives editability from local repository access without a mode control", async () => {
  const page = await renderPage("local");
  try {
    expect(textOf(page.dom, "[data-read-only]")).toBe("editable");
    expect(
      page.dom.window.document.querySelector("[data-page-mode-control]"),
    ).toBeNull();
    expect(page.calls.includes("repository_access_verify")).toBe(false);

    await act(async () => {
      page.dom.window.document
        .querySelector<HTMLButtonElement>("[data-run-mutation]")!
        .click();
      await nextTurn();
    });

    expect(page.events).toEqual(["body", "metadata", "mutation"]);
  } finally {
    await page.cleanup();
  }
});

domTest("Page starts fail-closed for blocked repository access without probing", async () => {
  const page = await renderPage("read_only");
  try {
    expect(textOf(page.dom, "[data-read-only]")).toBe("read-only");
    expect(
      page.dom.window.document.querySelector("[data-page-mode-control]"),
    ).toBeNull();
    expect(page.calls.includes("repository_access_verify")).toBe(false);
  } finally {
    await page.cleanup();
  }
});

domTest("access degradation commits a focused title draft before becoming read-only", async () => {
  const page = await renderPage("local", { renderTitle: true });
  try {
    const input = page.dom.window.document.querySelector<HTMLInputElement>(
      "[data-page-title] input",
    )!;
    await act(async () => {
      input.focus();
      setInputValue(input, "Renamed Page");
    });

    await act(async () => {
      page.setAccessStatus("read_only");
      page.dom.window.dispatchEvent(new page.dom.window.Event("focus"));
      await nextTurn();
      await nextTurn();
      await nextTurn();
    });

    expect(page.events.includes("title:Renamed Page")).toBe(true);
    expect(textOf(page.dom, "[data-saved-title]")).toBe("Renamed Page");
    expect(textOf(page.dom, "[data-read-only]")).toBe("read-only");
    expect(page.mountCount()).toBe(1);
  } finally {
    await page.cleanup();
  }
});

domTest("a positive canonical reread restores editable presentation automatically", async () => {
  const page = await renderPage("read_only");
  try {
    page.setAccessStatus("local");
    await act(async () => {
      page.dom.window.dispatchEvent(new page.dom.window.Event("focus"));
      await nextTurn();
      await nextTurn();
    });

    expect(textOf(page.dom, "[data-read-only]")).toBe("editable");
    expect(page.calls.includes("repository_access_verify")).toBe(false);
    expect(page.mountCount()).toBe(1);
  } finally {
    await page.cleanup();
  }
});

domTest("a busy source after its retries is a save error with an explicit retry", async () => {
  let busy = true;
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      if (busy) throw { kind: "source_busy", path: "page.md" };
    },
  });
  try {
    let ready = true;
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(false);
    expect(
      textOf(page.dom, "[data-slot=alert]").includes(
        "Another Svode operation is writing this file",
      ),
    ).toBe(true);

    busy = false;
    await act(async () => {
      buttonWithText(page.dom, "Retry save").click();
      await nextTurn();
    });
    expect(page.dom.window.document.querySelector("[data-slot=alert]")).toBe(
      null,
    );
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("a source conflict holds navigation and offers both explicit choices", async () => {
  const page = await renderPage("local", { renderRecovery: true });
  try {
    const choices: string[] = [];
    const conflict = {
      status: "ready" as const,
      pending: null,
      failure: null,
      writeDraft: () => choices.push("write"),
      loadFile: () => choices.push("load"),
      retryRead: () => choices.push("read"),
    };
    await act(async () => page.session().reportSourceConflict(conflict));

    const region = page.dom.window.document.querySelector(
      "[data-page-source-conflict]",
    )!;
    expect(
      region.textContent?.includes(
        "The file changed outside. Your text isn't saved yet",
      ),
    ).toBe(true);
    expect(region.querySelector("[role=alert]") !== null).toBe(true);
    // The editor keeps Tab for indentation: the recovery takes focus.
    expect(
      page.dom.window.document.activeElement?.contains(region) ?? false,
    ).toBe(true);
    let ready = true;
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(false);
    expect(page.events).toEqual(["body", "metadata"]);

    await act(async () => {
      buttonWithText(page.dom, "Load file version").click();
      buttonWithText(page.dom, "Save my text").click();
    });
    expect(choices).toEqual(["load", "write"]);

    await act(async () =>
      page.session().reportSourceConflict({ ...conflict, pending: "write" }),
    );
    expect(buttonWithText(page.dom, "Save my text").disabled).toBe(true);
    expect(buttonWithText(page.dom, "Load file version").disabled).toBe(true);

    await act(async () => page.session().reportSourceConflict(null));
    expect(
      page.dom.window.document.querySelector("[data-page-source-conflict]"),
    ).toBe(null);
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("a failed fresh read offers only reading again", async () => {
  const page = await renderPage("local", { renderRecovery: true });
  try {
    const choices: string[] = [];
    await act(async () =>
      page.session().reportSourceConflict({
        status: "read_failed",
        pending: null,
        failure: null,
        writeDraft: () => choices.push("write"),
        loadFile: () => choices.push("load"),
        retryRead: () => choices.push("read"),
      }),
    );
    expect(
      textOf(page.dom, "[data-page-source-conflict-note]").includes(
        "Couldn't read the file",
      ),
    ).toBe(true);
    expect(
      page.dom.window.document.querySelector(
        "[data-page-source-conflict-write]",
      ),
    ).toBe(null);
    await act(async () => buttonWithText(page.dom, "Read again").click());
    expect(choices).toEqual(["read"]);
  } finally {
    await page.cleanup();
  }
});

const OTHER = "/other-repo";
const otherRepositoryDenial = {
  kind: "repository_access_denied",
  reason: "auth_required",
  repositoryId: "repo-other",
  status: "read_only",
  blockers: [
    {
      reason: "auth_required",
      repositoryId: "repo-other",
      repositoryPath: OTHER,
      status: "read_only",
    },
  ],
};

domTest("a blocked leave names its cause, and staying keeps the draft at the recovery", async () => {
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      throw otherRepositoryDenial;
    },
  });
  try {
    let leave!: Promise<boolean>;
    await act(async () => {
      leave = page.session().prepareToLeave();
      await settle();
    });
    const question = page.dom.window.document.querySelector(
      "[data-page-discard-confirmation=leave]",
    )!;
    expect(question.textContent?.includes("Page changes are not saved")).toBe(
      true,
    );
    expect(
      question.textContent?.includes(
        "Saving is blocked: other-repo — read only.",
      ),
    ).toBe(true);
    expect(page.dom.window.document.activeElement?.textContent).toBe("Stay");
    // The recovery offers no action that hides it while the block remains.
    expect(buttonsWithText(page.dom, "Cancel").length).toBe(0);
    expect(buttonsWithText(page.dom, "Discard changes").length).toBe(1);

    await act(async () => {
      buttonWithText(page.dom, "Stay").click();
      await settle();
    });
    expect(await leave).toBe(false);
    expect(page.events.some((event) => event.startsWith("discard:"))).toBe(
      false,
    );
    const recovery = page.dom.window.document.querySelector(
      "[data-repository-access-inline-recovery]",
    )!;
    expect(recovery !== null).toBe(true);
    expect(
      page.dom.window.document.activeElement?.contains(recovery) ?? false,
    ).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("discarding on leave drops the drafts without saving and lets the navigation continue", async () => {
  let blocked = true;
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      if (blocked) throw otherRepositoryDenial;
    },
    bodyDiscard: async () => {
      blocked = false;
    },
  });
  try {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = page.session().prepareToLeave();
      await settle();
      second = page.session().prepareToLeave();
      await settle();
    });
    expect(
      page.dom.window.document.querySelectorAll(
        "[data-page-discard-confirmation]",
      ).length,
    ).toBe(1);
    page.events.length = 0;

    await act(async () => {
      buttonWithText(page.dom, "Discard changes and leave").click();
      await settle();
    });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(page.events).toEqual(["discard:body", "discard:metadata"]);
    expect(
      page.dom.window.document.querySelector(
        "[data-repository-access-inline-recovery]",
      ),
    ).toBeNull();
    let ready = false;
    await act(async () => {
      ready = await page.session().prepareToLeave();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("discard from the recovery asks first and keeps the draft when refused", async () => {
  let busy = true;
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      if (busy) throw { kind: "source_busy", path: "page.md" };
    },
    bodyDiscard: async () => {
      busy = false;
    },
  });
  try {
    await act(async () => {
      await page.session().prepareForNavigation();
    });
    // A non-leaving step stays a plain refusal without a question.
    expect(
      page.dom.window.document.querySelector(
        "[data-page-discard-confirmation]",
      ),
    ).toBeNull();
    page.events.length = 0;

    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    const question = page.dom.window.document.querySelector(
      "[data-page-discard-confirmation=discard]",
    )!;
    expect(question.textContent?.includes("Discard Page changes?")).toBe(true);
    expect(page.dom.window.document.activeElement?.textContent).toBe(
      "Keep changes",
    );
    await act(async () => {
      buttonWithText(page.dom, "Keep changes").click();
      await settle();
    });
    expect(page.events).toEqual([]);
    expect(
      page.dom.window.document.querySelector("[data-slot=alert]") !== null,
    ).toBe(true);

    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    await act(async () => {
      buttonsWithText(page.dom, "Discard changes")
        .find((button) => button.closest("[data-page-discard-confirmation]"))!
        .click();
      await settle();
    });
    expect(page.events).toEqual(["discard:body", "discard:metadata"]);
    expect(page.dom.window.document.querySelector("[data-slot=alert]")).toBe(
      null,
    );
    let ready = false;
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("a failed discard keeps the block and the draft", async () => {
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      throw { kind: "source_busy", path: "page.md" };
    },
    bodyDiscard: async () => {
      throw new Error("File not found");
    },
  });
  try {
    let leave!: Promise<boolean>;
    await act(async () => {
      leave = page.session().prepareToLeave();
      await settle();
    });
    await act(async () => {
      buttonWithText(page.dom, "Discard changes and leave").click();
      await settle();
    });
    expect(await leave).toBe(false);
    expect(page.events.includes("discard:metadata")).toBe(false);
    expect(
      page.dom.window.document.querySelector("[data-slot=alert]") !== null,
    ).toBe(true);
  } finally {
    await page.cleanup();
  }
});

async function renderPage(
  initialStatus: AccessStatus,
  options: {
    renderTitle?: boolean;
    renderRecovery?: boolean;
    bodyFlush?: () => Promise<void>;
    bodyDiscard?: () => Promise<void>;
  } = {},
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  const events: string[] = [];
  const spacePath = `/repository-work-mode-${Date.now()}-${Math.random()}`;
  let accessStatus = initialStatus;
  let generation = 0;
  let mounted = 0;
  mockNativeIpc(
    (command, args) => {
      calls.push(command);
      if (command === "repository_access_get") {
        generation += 1;
        if ((args as { spacePath?: string } | undefined)?.spacePath === OTHER)
          return snapshot("repo-other", "read_only", generation);
        return snapshot("repo-page-work-mode", accessStatus, generation);
      }
      if (command === "repository_access_verify") {
        throw new Error("Page open must not verify repository access");
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { PageSurfaceSessionProvider, usePageSurfaceSession } =
    await import("./page-surface-context");
  const { TitleZone } = await import("../ui/title-zone");
  const { PageAccessRecovery } = await import("../ui/page-access-recovery");
  let currentSession: ReturnType<typeof usePageSurfaceSession> | null = null;

  function Probe() {
    const session = usePageSurfaceSession();
    useEffect(() => {
      currentSession = session;
    });
    const [savedTitle, setSavedTitle] = useState("Page");
    const registerPersistence = session.registerPersistence;
    useEffect(() => {
      mounted += 1;
      const unregisterBody = registerPersistence("body", {
        flush: async () => {
          events.push("body");
          await options.bodyFlush?.();
        },
        discard: async () => {
          events.push("discard:body");
          await options.bodyDiscard?.();
        },
      });
      const unregisterMetadata = registerPersistence("metadata", {
        flush: async () => {
          events.push("metadata");
        },
        discard: async () => {
          events.push("discard:metadata");
        },
      });
      return () => {
        unregisterBody();
        unregisterMetadata();
      };
    }, [registerPersistence]);
    return (
      <>
        <span data-read-only>
          {session.readOnly ? "read-only" : "editable"}
        </span>
        {options.renderRecovery ? <PageAccessRecovery /> : null}
        {options.renderTitle ? (
          <>
            <div data-page-title>
              <TitleZone
                title={savedTitle}
                icon={null}
                description=""
                readOnly={session.readOnly}
                hideDescription
                fallbackEmoji="📄"
                onTitleChange={(title) => {
                  void session.runMutation(async () => {
                    events.push(`title:${title}`);
                    setSavedTitle(title);
                  });
                }}
                onIconChange={() => undefined}
                onDescriptionChange={() => undefined}
                onBodyFocus={() => undefined}
              />
            </div>
            <span data-saved-title>{savedTitle}</span>
          </>
        ) : null}
        <button
          data-run-mutation
          onClick={() =>
            void session.runMutation(async () => {
              events.push("mutation");
            })
          }
        />
      </>
    );
  }

  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(
      <PageSurfaceSessionProvider
        displayName="Page"
        displayPath="page.md"
        spacePath={spacePath}
        targetKey={spacePath}
      >
        <Probe />
      </PageSurfaceSessionProvider>,
    );
    await nextTurn();
    await nextTurn();
  });
  return {
    calls,
    events,
    dom,
    mountCount: () => mounted,
    session: () => currentSession!,
    setAccessStatus: (status: AccessStatus) => {
      accessStatus = status;
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
  };
}

type AccessStatus = "local" | "read_only";

function snapshot(
  repositoryId: string,
  status: AccessStatus,
  generation: number,
) {
  return {
    checkedAt: null,
    expiresAt: null,
    generation,
    lastKnownStatus: null,
    reason: status === "read_only" ? "auth_required" : null,
    repositoryId,
    status,
  };
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function buttonWithText(dom: JSDOM, text: string) {
  const button = [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`No button "${text}"`);
  return button;
}

function buttonsWithText(dom: JSDOM, text: string) {
  return [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((candidate) => candidate.textContent?.trim() === text);
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input.ownerDocument.defaultView!.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new input.ownerDocument.defaultView!.Event("input", { bubbles: true }),
  );
  const propertyChange = new input.ownerDocument.defaultView!.Event(
    "propertychange",
    { bubbles: true },
  );
  Object.defineProperty(propertyChange, "propertyName", { value: "value" });
  input.dispatchEvent(propertyChange);
}

function installDomGlobals(dom: JSDOM) {
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
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
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
