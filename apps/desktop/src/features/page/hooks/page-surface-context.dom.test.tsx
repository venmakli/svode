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

domTest("a blocked save replaces the update time with an indicator and keeps the layout free of alerts", async () => {
  const page = await renderPage("local", {
    renderRecovery: true,
    recoveryError: "Page could not be saved yet",
    bodyFlush: async () => {
      throw otherRepositoryDenial;
    },
  });
  try {
    const document = page.dom.window.document;
    expect(document.querySelector("[data-updated]")).toBeNull();
    const indicator = indicatorOf(page.dom)!;
    expect(indicator.dataset.pageSaveBlock).toBe("write");
    expect(indicator.textContent).toBe("Not saved");
    expect(indicator.getAttribute("aria-label")).toBe(
      "Not saved: Page could not be saved yet",
    );
    expect(textOf(page.dom, "[role=status]")).toBe(
      "Not saved: Page could not be saved yet",
    );
    expect(document.querySelector("[data-slot=alert]")).toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();

    await openRecovery(page.dom);
    expect(textOf(page.dom, "[role=dialog]").includes("Changes not saved")).toBe(
      true,
    );
    expect(
      textOf(page.dom, "[role=dialog]").includes("Page could not be saved yet"),
    ).toBe(true);

    // A refused access leads; the owner's own error is not repeated beside it.
    await act(async () => {
      await page.session().prepareForNavigation();
      await settle();
    });
    expect(indicatorOf(page.dom)?.dataset.pageSaveBlock).toBe("access");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.dataset.pageSaveRecovery).toBe("access");
    expect(dialog.textContent?.includes("Page could not be saved yet")).toBe(
      false,
    );
    expect(
      dialog.querySelectorAll("[data-repository-access-blocker-item]").length,
    ).toBe(1);
    expect(
      document.querySelector("[data-repository-access-inline-recovery]"),
    ).toBeNull();
    expect(buttonsWithText(page.dom, "Retry save").length).toBe(0);
    expect(buttonsWithText(page.dom, "Discard changes").length).toBe(1);
    expect(document.querySelector("[data-slot=alert]")).toBeNull();
  } finally {
    await page.cleanup();
  }
});

domTest("a busy source is retried from the Dialog, which closes and returns to the Page content", async () => {
  let busy = true;
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      if (busy) throw { kind: "source_busy", path: "page.md" };
    },
  });
  try {
    const document = page.dom.window.document;
    const editor = document.querySelector<HTMLElement>("[data-editor]")!;
    let ready = true;
    await act(async () => {
      editor.focus();
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(false);
    // The block is announced, but focus stays where the user works.
    expect(document.activeElement).toBe(editor);
    expect(indicatorOf(page.dom)?.getAttribute("aria-label")).toBe(
      "Not saved: Another Svode operation is writing this file — retry saving.",
    );

    await openRecovery(page.dom);
    expect(document.activeElement?.textContent).toBe("Retry save");
    busy = false;
    await act(async () => {
      buttonWithText(page.dom, "Retry save").click();
      await settle();
    });
    // The closed Dialog returns focus on the turn after it unmounts.
    await act(settle);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(indicatorOf(page.dom)).toBeNull();
    expect(document.querySelector("[data-updated]") !== null).toBe(true);
    expect(textOf(page.dom, "[role=status]")).toBe("");
    expect(document.activeElement).toBe(editor);
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("closing the Dialog keeps the block and returns focus to the indicator", async () => {
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      throw { kind: "source_busy", path: "page.md" };
    },
  });
  try {
    await act(async () => {
      await page.session().prepareForNavigation();
    });
    for (const close of ["button", "escape"] as const) {
      await openRecovery(page.dom);
      await act(async () => {
        if (close === "button") buttonWithText(page.dom, "Close").click();
        else
          page.dom.window.document.activeElement!.dispatchEvent(
            new page.dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }),
          );
        await settle();
      });
      expect(page.dom.window.document.querySelector("[role=dialog]")).toBeNull();
      expect(page.dom.window.document.activeElement).toBe(indicatorOf(page.dom));
    }
    expect(page.events.some((event) => event.startsWith("discard:"))).toBe(
      false,
    );
  } finally {
    await page.cleanup();
  }
});

domTest("a new failure of the retry updates the open Dialog", async () => {
  let failure: unknown = { kind: "source_busy", path: "page.md" };
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      throw failure;
    },
  });
  try {
    await act(async () => {
      await page.session().prepareForNavigation();
    });
    await openRecovery(page.dom);
    failure = otherRepositoryDenial;
    await act(async () => {
      buttonWithText(page.dom, "Retry save").click();
      await settle();
    });
    const dialog =
      page.dom.window.document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.dataset.pageSaveRecovery).toBe("access");
    expect(
      dialog.textContent?.includes(
        "Saving is blocked: write access is not confirmed.",
      ),
    ).toBe(true);
    expect(indicatorOf(page.dom)?.dataset.pageSaveBlock).toBe("access");
  } finally {
    await page.cleanup();
  }
});

domTest("a source conflict holds navigation and offers both explicit choices in the Dialog", async () => {
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
    const document = page.dom.window.document;
    expect(indicatorOf(page.dom)?.dataset.pageSaveBlock).toBe("conflict");
    expect(document.querySelector("[data-page-source-conflict]")).toBeNull();
    let ready = true;
    await act(async () => {
      ready = await page.session().prepareForNavigation();
    });
    expect(ready).toBe(false);
    expect(page.events).toEqual(["body", "metadata"]);

    await openRecovery(page.dom);
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.dataset.pageSaveRecovery).toBe("conflict");
    expect(
      dialog.textContent?.includes(
        "The file changed outside Svode; your text isn't saved yet",
      ),
    ).toBe(true);
    expect(document.activeElement?.textContent).toBe("Save my text");
    // Loading the file version is the discard of a conflict.
    expect(buttonsWithText(page.dom, "Discard changes").length).toBe(0);

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

    await act(async () => {
      page.session().reportSourceConflict(null);
      await settle();
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(indicatorOf(page.dom)).toBeNull();
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
    await openRecovery(page.dom);
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
    expect(
      page.dom.window.document.querySelector("[data-page-source-conflict-load]"),
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

domTest("a blocked leave names its cause, and staying keeps the draft at the indicator", async () => {
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
    expect(textOf(page.dom, "[role=alertdialog] h2")).toBe(
      "Leave the Page “Plan” without saving?",
    );
    // A repository no Project or Space owns is named by its path.
    expect(leaveDescription(page.dom)).toEqual([
      "Saving is blocked: /other-repo — read only.",
      "Unsaved changes will be lost.",
    ]);
    expect(question.textContent?.includes("Leave without saving")).toBe(true);
    expect(page.dom.window.document.activeElement?.textContent).toBe("Stay");

    await act(async () => {
      buttonWithText(page.dom, "Stay").click();
      await settle();
    });
    expect(await leave).toBe(false);
    expect(page.events.some((event) => event.startsWith("discard:"))).toBe(
      false,
    );
    const indicator = indicatorOf(page.dom)!;
    expect(indicator.getAttribute("aria-label")).toBe(
      "Not saved: Saving is blocked: /other-repo — read only.",
    );
    expect(page.dom.window.document.activeElement).toBe(indicator);
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
      buttonWithText(page.dom, "Leave without saving").click();
      await settle();
    });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(page.events).toEqual(["discard:body", "discard:metadata"]);
    expect(indicatorOf(page.dom)).toBeNull();
    let ready = false;
    await act(async () => {
      ready = await page.session().prepareToLeave();
    });
    expect(ready).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("discard from the Dialog asks in place and keeps the draft when refused", async () => {
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
    const document = page.dom.window.document;
    const editor = document.querySelector<HTMLElement>("[data-editor]")!;
    await act(async () => {
      editor.focus();
      await page.session().prepareForNavigation();
    });
    // A non-leaving step stays a plain refusal without a question.
    expect(
      document.querySelector("[data-page-discard-confirmation]"),
    ).toBeNull();
    page.events.length = 0;

    await openRecovery(page.dom);
    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    expect(document.querySelectorAll("[role=dialog]").length).toBe(1);
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.dataset.pageSaveStep).toBe("discard");
    expect(textOf(page.dom, "[role=dialog] h2")).toBe(
      "Discard changes in “Plan”?",
    );
    expect(textOf(page.dom, "[role=dialog] p")).toBe(
      "The Page returns to its last saved version, and unsaved edits are removed. Files and Git are not changed.",
    );
    expect(document.activeElement?.textContent).toBe("Keep changes");
    await act(async () => {
      buttonWithText(page.dom, "Keep changes").click();
      await settle();
    });
    expect(page.events).toEqual([]);
    expect(dialog.dataset.pageSaveStep).toBe("recovery");
    expect(document.activeElement?.textContent).toBe("Retry save");

    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    await act(settle);
    expect(page.events).toEqual(["discard:body", "discard:metadata"]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(indicatorOf(page.dom)).toBeNull();
    expect(document.activeElement).toBe(editor);
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
      buttonWithText(page.dom, "Leave without saving").click();
      await settle();
    });
    expect(await leave).toBe(false);
    expect(page.events.includes("discard:metadata")).toBe(false);
    expect(indicatorOf(page.dom) !== null).toBe(true);

    await openRecovery(page.dom);
    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    await act(async () => {
      buttonWithText(page.dom, "Discard changes").click();
      await settle();
    });
    const dialog =
      page.dom.window.document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.dataset.pageSaveStep).toBe("recovery");
    expect(indicatorOf(page.dom) !== null).toBe(true);
  } finally {
    await page.cleanup();
  }
});

domTest("a Peek close or expand question names its action, and Escape stays at the indicator", async () => {
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      throw { kind: "source_busy", path: "page.md" };
    },
  });
  try {
    const document = page.dom.window.document;
    for (const [action, title, discard] of [
      ["close", "Close “Plan” without saving?", "Close without saving"],
      ["expand", "Expand “Plan” without saving?", "Expand without saving"],
    ] as const) {
      let leave!: Promise<boolean>;
      await act(async () => {
        leave = page.session().prepareToLeave(action);
        await settle();
      });
      expect(
        document.querySelector<HTMLElement>("[data-page-discard-confirmation]")
          ?.dataset.pageDiscardConfirmation,
      ).toBe(action);
      expect(textOf(page.dom, "[role=alertdialog] h2")).toBe(title);
      expect(leaveDescription(page.dom)).toEqual([
        "Another Svode operation is writing this file — retry saving.",
        "Unsaved changes will be lost.",
      ]);
      expect(buttonsWithText(page.dom, discard).length).toBe(1);
      expect(document.activeElement?.textContent).toBe("Stay");

      await act(async () => {
        document.activeElement!.dispatchEvent(
          new page.dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await settle();
      });
      await act(settle);
      expect(await leave).toBe(false);
      expect(
        document.querySelector("[data-page-discard-confirmation]"),
      ).toBeNull();
      expect(document.activeElement).toBe(indicatorOf(page.dom));
    }
    expect(page.events.some((event) => event.startsWith("discard:"))).toBe(
      false,
    );
  } finally {
    await page.cleanup();
  }
});

domTest("the leave question names a source conflict and a failed write as their cause", async () => {
  let fail = false;
  const page = await renderPage("local", {
    renderRecovery: true,
    bodyFlush: async () => {
      if (fail) throw new Error("Disk full");
    },
  });
  try {
    const conflict = {
      status: "ready" as const,
      pending: null,
      failure: null,
      writeDraft: () => undefined,
      loadFile: () => undefined,
      retryRead: () => undefined,
    };
    await act(async () => page.session().reportSourceConflict(conflict));
    const ask = async () => {
      let leave!: Promise<boolean>;
      await act(async () => {
        leave = page.session().prepareToLeave();
        await settle();
      });
      const description = leaveDescription(page.dom);
      await act(async () => {
        buttonWithText(page.dom, "Stay").click();
        await settle();
      });
      await act(settle);
      expect(await leave).toBe(false);
      return description;
    };
    expect(await ask()).toEqual([
      "The file changed outside Svode; your text isn't saved yet",
      "Unsaved changes will be lost.",
    ]);

    await act(async () => page.session().reportSourceConflict(null));
    fail = true;
    expect(await ask()).toEqual([
      "Couldn't write the changes — the draft stays open.",
      "Unsaved changes will be lost.",
    ]);
  } finally {
    await page.cleanup();
  }
});

function leaveDescription(dom: JSDOM) {
  return [
    ...dom.window.document.querySelectorAll(
      "[data-slot=alert-dialog-description] > span",
    ),
  ].map((line) => line.textContent);
}

function indicatorOf(dom: JSDOM) {
  return dom.window.document.querySelector<HTMLButtonElement>(
    "[data-page-save-block]",
  );
}

async function openRecovery(dom: JSDOM) {
  await act(async () => {
    indicatorOf(dom)!.click();
    await settle();
  });
}

async function renderPage(
  initialStatus: AccessStatus,
  options: {
    renderTitle?: boolean;
    renderRecovery?: boolean;
    recoveryError?: string;
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
  const { PageSaveStatus } = await import("../ui/page-save-status");
  let currentSession: ReturnType<typeof usePageSurfaceSession> | null = null;

  function Probe() {
    const session = usePageSurfaceSession();
    useEffect(() => {
      currentSession = session;
    });
    const [savedTitle, setSavedTitle] = useState("Page");
    const { registerPersistence, registerTitle } = session;
    useEffect(() => registerTitle("Plan"), [registerTitle]);
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
        {options.renderRecovery ? (
          <>
            <textarea data-editor />
            <PageSaveStatus
              title="Plan"
              error={options.recoveryError}
              onRetry={
                options.recoveryError ? async () => undefined : undefined
              }
            >
              <time data-updated>upd.</time>
            </PageSaveStatus>
          </>
        ) : null}
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
      // A closed Dialog returns focus on the turn after it unmounts.
      await act(settle);
      await act(async () => root.unmount());
      await settle();
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
