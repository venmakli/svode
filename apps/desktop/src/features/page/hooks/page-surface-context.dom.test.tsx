import { expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

test("Page derives editability from local repository access without a mode control", async () => {
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

test("Page starts fail-closed for blocked repository access without probing", async () => {
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

test("access degradation commits a focused title draft before becoming read-only", async () => {
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

test("a positive canonical reread restores editable presentation automatically", async () => {
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

test("a busy source after its retries is a save error with an explicit retry", async () => {
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

test("a source conflict holds navigation and offers both explicit choices", async () => {
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

test("a failed fresh read offers only reading again", async () => {
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

async function renderPage(
  initialStatus: AccessStatus,
  options: {
    renderTitle?: boolean;
    renderRecovery?: boolean;
    bodyFlush?: () => Promise<void>;
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
    (command) => {
      calls.push(command);
      if (command === "repository_access_get") {
        generation += 1;
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
      const unregisterBody = registerPersistence("body", async () => {
        events.push("body");
        await options.bodyFlush?.();
      });
      const unregisterMetadata = registerPersistence("metadata", async () => {
        events.push("metadata");
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
