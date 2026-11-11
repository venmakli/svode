import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import type { AgentSessionKeyDto } from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_COMPOSER_FOCUS_DOM !== "1") {
  test("composer focus DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_COMPOSER_FOCUS_DOM: "1" },
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  installDomGlobals(dom);
  // Keys and typing reach Slate only in an editable field, as `beforeinput`
  // as in WebKit.
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true";
    },
  });
  Object.defineProperty(dom.window.InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => [],
  });
  // WebKit keeps a caret already placed in the field it focuses.
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    const selection = dom.window.document.getSelection();
    const caret =
      selection?.rangeCount && this.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    focus.call(this, options);
    if (caret) {
      selection!.removeAllRanges();
      selection!.addRange(caret);
    }
  };
  // WebKit takes focus off a field that stops being editable, keeping the
  // page selection and reporting no selection change.
  let quietSelectionChanges = 0;
  dom.window.addEventListener(
    "selectionchange",
    (event) => {
      if (quietSelectionChanges === 0) return;
      quietSelectionChanges -= 1;
      event.stopImmediatePropagation();
    },
    true,
  );
  new dom.window.MutationObserver((mutations) => {
    for (const { target } of mutations) {
      const element = target as HTMLElement;
      if (
        element.getAttribute("contenteditable") === "false" &&
        element.contains(document.activeElement)
      ) {
        const selection = dom.window.document.getSelection()!;
        const kept = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        (document.activeElement as HTMLElement).blur();
        if (kept) {
          quietSelectionChanges += 2;
          selection.addRange(kept);
        }
      }
    }
  }).observe(dom.window.document.body, {
    attributes: true,
    attributeFilter: ["contenteditable"],
    subtree: true,
  });
  const { createRoot } = await import("react-dom/client");

  const spaceState = {
    activeRootIcon: null,
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: "/project",
    rootSpaces: [],
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  const key: AgentSessionKeyDto = { agent: "codex", namespace: "native", sessionId: "s1" };
  /** What a prompt answers; a pending promise holds the send. */
  let promptAnswer: () => Promise<string> = async () => "turn-1";
  let writer = "acp";
  /** The agent's request a session's first snapshot carries. */
  let firstPending: unknown = null;
  const prompts: unknown[] = [];
  /** The request mark each prompt carried (Stage 11 1.10). */
  const marks: unknown[] = [];
  /** The answers given to requests of the agent. */
  const answers: unknown[] = [];
  /** The activity channel of each session and its next message index. */
  const channels = new Map<string, { id: number; index: number }>();

  const { mockNativeIpc, mockNativeWindow } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "agent_runtime_subscribe": {
        const channel = payload.channel as { id: number };
        const session = payload.session as AgentSessionKeyDto;
        channels.set(session.sessionId, { id: channel.id, index: 1 });
        setTimeout(() =>
          runCallback(channel.id, {
            index: 0,
            message: { type: "snapshot", value: snapshot(session) },
          }),
        );
        return 1;
      }
      case "agent_runtime_prompt":
        prompts.push(payload.prompt);
        marks.push(payload.mark ?? null);
        return promptAnswer();
      case "agent_runtime_start_session":
        prompts.push(payload.prompt);
        marks.push(payload.mark ?? null);
        return promptAnswer().then((turnId) => ({
          outcome: "started",
          session: { ...key, sessionId: "s2" },
          sessionId: "codex:s2",
          turnId,
        }));
      case "path_exists":
        return true;
      case "agent_runtime_hold_draft":
        return {
          hold: 5,
          check: { state: "ready", agent: { name: "codex-acp", version: "2.1.1" } },
          session: { ...key, sessionId: "d1" },
        };
      case "agent_setup_chat_agents":
        return {
          agents: [{ agent: "codex", name: "Codex", offer: { state: "available" } }],
          last: null,
        };
      case "agent_adapters_list_identities":
        return [{ id: "codex", displayName: "Codex" }];
      case "agent_runtime_answer":
        answers.push(payload.answer);
        return null;
      case "agent_runtime_unsubscribe":
      case "agent_runtime_release_draft":
      case "agent_runtime_cancel":
        return null;
    }
    if (command.startsWith("plugin:")) return 1;
    throw new Error(`unexpected command ${command}`);
  }, { shouldMockEvents: true });
  mockNativeWindow();

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { SessionChat } = await import("./session-chat");
  const { NewSessionDraft } = await import("./new-session-draft");
  const { newSessionDraftKey, readComposerDraft, sessionDraftKey, writeComposerDraft } =
    await import("../model/composer");
  const { putNewSessionRequest, putSessionRequest } = await import(
    "../hooks/composer-request"
  );

  const DRAFT = sessionDraftKey("codex:s1");
  let root: Root | null = null;

  function focusTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      promptAnswer = async () => "turn-1";
      writer = "acp";
      firstPending = null;
      prompts.length = 0;
      marks.length = 0;
      answers.length = 0;
      try {
        await fn();
      } finally {
        await act(async () => root?.unmount());
        root = null;
        document.body.innerHTML = "";
        window.sessionStorage.clear();
      }
    });
  }

  async function mount(element: React.ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TooltipProvider>{element}</TooltipProvider>);
    });
    await settle();
  }

  function field() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    )!;
  }

  async function fieldFocused() {
    await pastFocusRetries();
    return field().contains(document.activeElement);
  }

  /** Past the retries the editor makes to take focus itself. */
  async function pastFocusRetries() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  }

  function stored(storageKey = DRAFT) {
    return (readComposerDraft(storageKey)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  /** The caret's offset in the field's text, or null without one inside it. */
  async function caret() {
    await pastFocusRetries();
    const selection = document.getSelection();
    if (!selection?.rangeCount || !field().contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(field());
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return range.toString().length;
  }

  async function focusField() {
    await act(async () => field().focus());
    await settle();
  }

  async function type(text: string) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new window.InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
        }),
      );
      document.activeElement?.dispatchEvent(
        new window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true }),
      );
    });
    await settle();
  }

  /** Typing one key after another, as `beforeinput` of each character. */
  async function typeKeys(text: string) {
    for (const character of text) await type(character);
  }

  /**
   * Keys pressed one after another as the page gets them: `keydown` on
   * whatever has focus, and the typed text as `beforeinput` only where
   * focus is in an editable field.
   */
  async function pressKeys(text: string) {
    for (const character of text) {
      await act(async () => {
        const target = document.activeElement ?? document.body;
        const down = new window.KeyboardEvent("keydown", {
          key: character,
          bubbles: true,
          cancelable: true,
        });
        if (!target.dispatchEvent(down)) return;
        if (!(target as HTMLElement).isContentEditable) return;
        target.dispatchEvent(
          new window.InputEvent("beforeinput", {
            inputType: "insertText",
            data: character,
            bubbles: true,
            cancelable: true,
          }),
        );
        target.dispatchEvent(
          new window.InputEvent("input", { inputType: "insertText", data: character, bubbles: true }),
        );
      });
      await settle();
    }
  }

  /** The text of the field. */
  function fieldText() {
    return field().textContent?.replace(/\uFEFF/g, "") ?? "";
  }

  async function pressEnter() {
    await act(async () => {
      field().dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  /** The session's turn changes, which renders the chat and its field. */
  function turnChange(
    phase: "none" | "running" | "cancelling",
    lastOutcome: string | null = null,
    sessionId = "s1",
  ) {
    const channel = channels.get(sessionId)!;
    const index = channel.index++;
    runCallback(channel.id, {
      index,
      message: {
        type: "delta",
        value: {
          seq: index,
          change: "turn",
          value: {
            turnId: "turn-1",
            phase,
            lastOutcome,
            status: {
              state: phase === "none" ? "idle" : "working",
              stopReason: null,
              source: "svode_runtime",
              confidence: "exact",
            },
          },
        },
      },
    });
  }

  /** A click into the field at `offset` of its text while the turn renders it. */
  async function clickDuringTurn(offset: number) {
    await act(async () => {
      field().focus();
      const text = field().querySelector("[data-slate-string]")?.firstChild;
      const range = document.createRange();
      if (text) range.setStart(text, offset);
      else range.setStart(field(), 0);
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      // An update of the turn renders the field before the editor reads
      // the new page selection.
      turnChange("running");
    });
    await settle();
  }

  function deferred() {
    let resolve!: (turnId: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  const REQUEST = {
    id: "perm-1",
    kind: "permission",
    title: "Run this command?",
    toolCallId: null,
    options: [
      { id: "allow", label: "Allow", kind: "allow_once" },
      { id: "reject", label: "Reject", kind: "reject_once" },
    ],
    fields: [],
    state: "pending",
  };

  /** The agent's request arrives or closes in the given state. */
  function pendingChange(state: string, sessionId = "s1") {
    const channel = channels.get(sessionId)!;
    const index = channel.index++;
    runCallback(channel.id, {
      index,
      message: {
        type: "delta",
        value: { seq: index, change: "pending", value: { ...REQUEST, state } },
      },
    });
  }

  function button(label: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute("aria-label") === label,
    )!;
  }

  const chat = () => <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />;

  focusTest("after an accepted send the empty field keeps focus and takes typing", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    // Sending: the text stays and takes no edits.
    expect(field().textContent).toBe("Hello");
    await act(async () => send.resolve("turn-1"));
    await settle();
    expect(prompts.length).toBe(1);
    expect(stored()).toBe("");
    expect(await fieldFocused()).toBe(true);
    await type("abc");
    expect(stored()).toBe("abc");
  });

  focusTest("a refused send leaves its text in the focused field with the caret at the end", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    promptAnswer = async () => {
      throw { kind: "agent_runtime", code: "turn_active", message: "busy" };
    };
    await pressEnter();
    expect(document.body.textContent?.includes(m.sessions_chat_refusal_turn_active())).toBe(true);
    expect(stored()).toBe("Hello");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("Hello".length);
  });

  focusTest("a send of unknown outcome comes back marked, in the focused field", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    promptAnswer = async () => {
      throw new Error("lost");
    };
    await pressEnter();
    // The session shows no new turn before the reconcile wait ends.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_600)));
    await settle();
    expect(document.body.textContent?.includes(m.sessions_chat_not_sent())).toBe(true);
    expect(stored()).toBe("Hello");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("Hello".length);
  });

  focusTest("focus moved elsewhere during the send stays there", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await act(async () => elsewhere.focus());
    await act(async () => send.resolve("turn-1"));
    await settle();
    await pastFocusRetries();
    expect(stored()).toBe("");
    expect(document.activeElement).toBe(elsewhere);
  });

  focusTest("a send that attaches a read session leaves focus in the field of the attached session", async () => {
    writer = "none";
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Continue" }] });
    function Read() {
      const [epoch, setEpoch] = useState(0);
      const [attaching, setAttaching] = useState(false);
      return (
        <SessionChat
          sessionId="codex:s1"
          session={key}
          scope={{ kind: "project", name: "Project", icon: null }}
          epoch={epoch}
          continuation={{
            liveness: "unknown",
            attaching,
            refusal: null,
            sessionValues: null,
            attach: async () => {
              setAttaching(true);
              await new Promise((resolve) => setTimeout(resolve, 10));
              writer = "acp";
              setEpoch((value) => value + 1);
              setAttaching(false);
              return { attached: true };
            },
            refresh: () => undefined,
            refreshing: false,
            onCopyResumeCommand: null,
          }}
        />
      );
    }
    // Opened from the sidebar, which keeps focus.
    const sidebar = document.createElement("button");
    document.body.append(sidebar);
    sidebar.focus();
    await mount(<Read />);
    await focusField();
    // The send attaches the session itself, without a confirmation.
    await pressEnter();
    expect(prompts.length).toBe(1);
    expect(stored()).toBe("");
    expect(await fieldFocused()).toBe(true);
  });

  /** A host showing a new session draft, then the session it creates. */
  function DraftHost() {
    const [started, setStarted] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    // The peek around the session takes focus when the draft's field
    // goes, as its focus trap does.
    const trap = (element: HTMLDivElement | null) => {
      if (!element) return;
      new window.MutationObserver((mutations) => {
        if (
          document.activeElement === document.body &&
          mutations.some((mutation) => mutation.removedNodes.length > 0)
        ) {
          element.focus();
        }
      }).observe(element, { childList: true, subtree: true });
    };
    return (
      <div ref={trap} tabIndex={-1}>
        {started === null ? (
          <NewSessionDraft
            spacePath="/project"
            onStarted={(session) => {
              setStarted(session.sessionId);
              // The host shows the created session once it has it.
              setTimeout(() => setShown(true), 10);
            }}
            onOpenAgentSettings={() => undefined}
          />
        ) : shown ? (
          <SessionChat
            sessionId={started}
            session={{ ...key, sessionId: "s2" }}
            scope={{ kind: "project", name: "Project", icon: null }}
          />
        ) : null}
      </div>
    );
  }

  focusTest("the first send of a new session draft leaves focus in the created session's field", async () => {
    await mount(<DraftHost />);
    await focusField();
    await type("Start");
    await pressEnter();
    expect(prompts.length).toBe(1);
    expect(Boolean(document.querySelector("[data-session-chat-bottom]"))).toBe(true);
    expect(await fieldFocused()).toBe(true);
    // The started send leaves nothing for the next draft to mark as not
    // sent (DF-214).
    expect(readComposerDraft(newSessionDraftKey("/project"))?.sending ?? null).toBeNull();
    expect(readComposerDraft(newSessionDraftKey("/project"))?.parts ?? []).toEqual([]);
  });

  focusTest(
    "a request goes after the typed text with focus at its end, waits for the user and its send carries the mark",
    async () => {
      writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "My note" }] });
      await mount(chat());
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();
      await act(async () =>
        putSessionRequest("codex:s1", "Commit the changes", "agent_commits"),
      );
      await settle();
      expect(stored()).toBe("My note\n\nCommit the changes");
      expect(readComposerDraft(DRAFT)?.mark).toBe("agent_commits");
      expect(await fieldFocused()).toBe(true);
      expect(await caret()).toBe("My note\n\nCommit the changes".length);
      // Nothing is sent until the user sends it.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(prompts.length).toBe(0);
      await pressEnter();
      expect(prompts.length).toBe(1);
      expect(marks).toEqual(["agent_commits"]);
      expect(stored()).toBe("");
      expect(readComposerDraft(DRAFT)?.mark ?? null).toBeNull();
      // The next turn of the session is an ordinary one.
      await type("Thanks");
      await pressEnter();
      expect(marks).toEqual(["agent_commits", null]);
    },
  );

  focusTest("clearing the composer drops the request mark", async () => {
    await mount(chat());
    await act(async () =>
      putSessionRequest("codex:s1", "Commit the changes", "agent_commits"),
    );
    await settle();
    expect(await fieldFocused()).toBe(true);
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(field());
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    await settle();
    await act(async () => {
      field().dispatchEvent(
        new window.InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    expect(stored()).toBe("");
    expect(readComposerDraft(DRAFT)?.mark ?? null).toBeNull();
    await type("Something else");
    await pressEnter();
    expect(marks).toEqual([null]);
  });

  focusTest(
    "a request for a new session fills its draft, focuses its field once shown and starts the session with the mark",
    async () => {
      await act(async () =>
        putNewSessionRequest("/project", "Commit the changes", "agent_commits"),
      );
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      expect(await fieldFocused()).toBe(true);
      expect(field().textContent).toBe("Commit the changes");
      expect(prompts.length).toBe(0);
      await pressEnter();
      expect(prompts.length).toBe(1);
      expect(marks).toEqual(["agent_commits"]);
    },
  );


  focusTest("during a turn a click puts the caret in the field and typing reaches the draft", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    await pressEnter();
    await act(async () => turnChange("running"));
    await settle();
    await pastFocusRetries();
    expect(stored()).toBe("");
    await clickDuringTurn(0);
    await type("next");
    expect(stored()).toBe("next");
    expect(field().textContent).toBe("next");
  });

  focusTest("during a turn a click in the middle of the draft puts the caret there", async () => {
    await mount(chat());
    await focusField();
    await type("abc def");
    await act(async () => turnChange("running"));
    await settle();
    await clickDuringTurn(3);
    await type("X");
    expect(stored()).toBe("abcX def");
  });

  focusTest("a prompt that returns after the session showed its turn keeps what was typed since", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    // The session shows the new turn first: the send is accepted.
    await act(async () => turnChange("running"));
    await settle();
    await pastFocusRetries();
    expect(stored()).toBe("");
    await type("next");
    await act(async () => send.resolve("turn-1"));
    await settle();
    expect(stored()).toBe("next");
    expect(field().textContent).toBe("next");
  });

  focusTest("a draft typed during a turn stays after it completes or is cancelled", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    await pressEnter();
    await act(async () => turnChange("running"));
    await settle();
    await pastFocusRetries();
    await type("next");
    await act(async () => turnChange("none", "end_turn"));
    await settle();
    expect(stored()).toBe("next");
    expect(field().textContent).toBe("next");

    await act(async () => turnChange("running"));
    await settle();
    await type(" more");
    await act(async () => turnChange("cancelling"));
    await act(async () => turnChange("none", "cancelled"));
    await settle();
    expect(stored()).toBe("next more");
    expect(field().textContent).toBe("next more");
  });

  focusTest("while sending the field keeps focus and the text being sent takes no edits", async () => {
    await mount(chat());
    await focusField();
    // Typed, so undo has something to take back.
    await type("Hello");
    const focusOuts: Event[] = [];
    field().addEventListener("focusout", (event) => focusOuts.push(event));
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    expect(field().getAttribute("contenteditable")).toBe("true");
    expect(field().contains(document.activeElement)).toBe(true);
    await typeKeys("ab");
    await act(async () => {
      field().dispatchEvent(
        new window.InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      );
      field().dispatchEvent(
        new window.InputEvent("beforeinput", {
          inputType: "insertLineBreak",
          bubbles: true,
          cancelable: true,
        }),
      );
      const paste = new window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: {
          types: ["text/plain"],
          files: [],
          items: [],
          getData: (type: string) => (type === "text/plain" ? "pasted" : ""),
        },
      });
      field().dispatchEvent(paste);
      const drop = new window.MouseEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: {
          types: ["text/plain"],
          files: [],
          items: [],
          dropEffect: "none",
          getData: (type: string) => (type === "text/plain" ? "dropped" : ""),
        },
      });
      field().dispatchEvent(drop);
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        field().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "z",
            bubbles: true,
            cancelable: true,
            ...modifier,
          }),
        );
      }
    });
    await settle();
    // Enter does not send again.
    await pressEnter();
    expect(fieldText()).toBe("Hello");
    expect(stored()).toBe("Hello");
    expect(prompts.length).toBe(1);
    expect(focusOuts.length).toBe(0);
    expect(field().contains(document.activeElement)).toBe(true);
    await act(async () => send.resolve("turn-1"));
    await settle();
    expect(stored()).toBe("ab");
    expect(fieldText()).toBe("ab");
  });

  focusTest("Cyrillic and Latin typed while sending stand in the field in typing order once the send is accepted", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await typeKeys("черновик draft");
    expect(fieldText()).toBe("Hello");
    await act(async () => send.resolve("turn-1"));
    await settle();
    expect(prompts).toEqual([[{ type: "text", text: "Hello" }]]);
    expect(stored()).toBe("черновик draft");
    expect(fieldText()).toBe("черновик draft");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("черновик draft".length);
    await type("!");
    expect(stored()).toBe("черновик draft!");
  });

  focusTest("text typed while sending stands after the text of a refused send, caret at the end", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await typeKeys(" ещё more");
    await act(async () =>
      send.reject({ kind: "agent_runtime", code: "turn_active", message: "busy" }),
    );
    await settle();
    expect(document.body.textContent?.includes(m.sessions_chat_refusal_turn_active())).toBe(true);
    expect(stored()).toBe("Hello ещё more");
    expect(fieldText()).toBe("Hello ещё more");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("Hello ещё more".length);
  });

  focusTest("text typed while sending stands after the text of a send not sent, which stays marked", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await typeKeys(" again");
    await act(async () => send.reject(new Error("lost")));
    await settle();
    // Still sending until the reconcile wait ends; typing still waits.
    await typeKeys(" now");
    expect(fieldText()).toBe("Hello");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_600)));
    await settle();
    expect(document.body.textContent?.includes(m.sessions_chat_not_sent())).toBe(true);
    expect(stored()).toBe("Hello again now");
    expect(fieldText()).toBe("Hello again now");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("Hello again now".length);
  });

  focusTest("text typed before focus moved elsewhere during the send stands in the field", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello" }] });
    await mount(chat());
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await focusField();
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await typeKeys("ab");
    await act(async () => elsewhere.focus());
    await act(async () => send.resolve("turn-1"));
    await settle();
    await pastFocusRetries();
    expect(stored()).toBe("ab");
    expect(fieldText()).toBe("ab");
    expect(document.activeElement).toBe(elsewhere);
  });

  focusTest("text typed during the first send of a new session draft stands in the created session's focused field", async () => {
    await mount(<DraftHost />);
    await focusField();
    await type("Start");
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await typeKeys("и дальше");
    expect(fieldText()).toBe("Start");
    await act(async () => send.resolve("turn-1"));
    await settle();
    expect(prompts).toEqual([[{ type: "text", text: "Start" }]]);
    expect(Boolean(document.querySelector("[data-session-chat-bottom]"))).toBe(true);
    expect(stored(sessionDraftKey("codex:s2"))).toBe("и дальше");
    expect(fieldText()).toBe("и дальше");
    expect(await fieldFocused()).toBe(true);
    expect(await caret()).toBe("и дальше".length);
    expect(readComposerDraft(newSessionDraftKey("/project"))?.parts ?? []).toEqual([]);
  });

  /**
   * The main area showing a new session draft: its first send makes the
   * created session the main area object at once, which takes focus as
   * its surface does, and the chat shows its field only once the session
   * is known and its snapshot came, here when `known` resolves.
   */
  function MainAreaHost({ known }: { known: Promise<unknown> }) {
    const [started, setStarted] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    return started === null ? (
      <NewSessionDraft
        spacePath="/project"
        onStarted={(session) => {
          setStarted(session.sessionId);
          void known.then(() => setShown(true));
        }}
        onOpenAgentSettings={() => undefined}
      />
    ) : (
      <FocusedSurface>
        {shown ? (
          <SessionChat
            sessionId={started}
            session={{ ...key, sessionId: "s2" }}
            scope={{ kind: "project", name: "Project", icon: null }}
          />
        ) : null}
      </FocusedSurface>
    );
  }

  function FocusedSurface({ children }: { children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => ref.current?.focus({ preventScroll: true }), []);
    return (
      <div ref={ref} tabIndex={-1}>
        {children}
      </div>
    );
  }

  focusTest("keys pressed during the first send of a new session draft and before the created session's field shows stand in that field in typing order", async () => {
    const known = deferred();
    await mount(<MainAreaHost known={known.promise} />);
    await focusField();
    await type("Start");
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await pressKeys("ab");
    expect(fieldText()).toBe("Start");
    await act(async () => send.resolve("turn-1"));
    await settle();
    // The created session is the main area object; its chat is not shown yet.
    expect(document.querySelector(`[aria-label="${m.sessions_chat_composer_label()}"]`)).toBeNull();
    await pressKeys("cd ч");
    await act(async () => known.resolve("known"));
    await settle();
    expect(await fieldFocused()).toBe(true);
    await pressKeys("ef");
    expect(prompts).toEqual([[{ type: "text", text: "Start" }]]);
    expect(fieldText()).toBe("abcd чef");
    expect(stored(sessionDraftKey("codex:s2"))).toBe("abcd чef");
    expect(await caret()).toBe("abcd чef".length);
    expect(readComposerDraft(newSessionDraftKey("/project"))?.parts ?? []).toEqual([]);
  });

  focusTest("keys pressed after focus moved elsewhere before the created session's field shows stay out of it", async () => {
    const known = deferred();
    await mount(<MainAreaHost known={known.promise} />);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await focusField();
    await type("Start");
    const send = deferred();
    promptAnswer = () => send.promise;
    await pressEnter();
    await act(async () => send.resolve("turn-1"));
    await settle();
    await pressKeys("ab");
    await act(async () => elsewhere.focus());
    await pressKeys("xy");
    await act(async () => known.resolve("known"));
    await settle();
    await pastFocusRetries();
    expect(fieldText()).toBe("ab");
    expect(stored(sessionDraftKey("codex:s2"))).toBe("ab");
    expect(document.activeElement).toBe(elsewhere);
  });

  focusTest("keys pressed after the created session's chat shows a request card instead of its field stay out of its draft", async () => {
    const known = deferred();
    await mount(<MainAreaHost known={known.promise} />);
    await focusField();
    await type("Start");
    await pressEnter();
    await pressKeys("ab");
    firstPending = { ...REQUEST, state: "pending" };
    await act(async () => known.resolve("known"));
    await settle();
    expect(document.querySelector(`[aria-label="${m.sessions_chat_composer_label()}"]`)).toBeNull();
    await pressKeys("xy");
    expect(stored(sessionDraftKey("codex:s2"))).toBe("ab");
    expect(answers.length).toBe(0);
    await act(async () => pendingChange("answered", "s2"));
    await settle();
    expect(fieldText()).toBe("ab");
  });

  focusTest("text typed during Connect and send of a read session stands in the field of the attached session", async () => {
    writer = "none";
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Continue" }] });
    const attached = deferred();
    function Read() {
      const [epoch, setEpoch] = useState(0);
      const [attaching, setAttaching] = useState(false);
      return (
        <SessionChat
          sessionId="codex:s1"
          session={key}
          scope={{ kind: "project", name: "Project", icon: null }}
          epoch={epoch}
          continuation={{
            liveness: "unknown",
            attaching,
            refusal: null,
            sessionValues: null,
            attach: async () => {
              setAttaching(true);
              await attached.promise;
              writer = "acp";
              setEpoch((value) => value + 1);
              setAttaching(false);
              return { attached: true };
            },
            refresh: () => undefined,
            refreshing: false,
            onCopyResumeCommand: null,
          }}
        />
      );
    }
    await mount(<Read />);
    await focusField();
    await pressEnter();
    await typeKeys("next");
    expect(fieldText()).toBe("Continue");
    expect(prompts.length).toBe(0);
    await act(async () => attached.resolve("attached"));
    await settle();
    expect(prompts).toEqual([[{ type: "text", text: "Continue" }]]);
    expect(stored()).toBe("next");
    expect(fieldText()).toBe("next");
    expect(await fieldFocused()).toBe(true);
  });

  for (const close of ["Allow", "Reject", "stop"] as const) {
    focusTest(`typing right after an accepted send keeps its order when the request card comes and closes by ${close}`, async () => {
      writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Run it" }] });
      await mount(chat());
      await focusField();
      const send = deferred();
      promptAnswer = () => send.promise;
      await pressEnter();
      await typeKeys("че");
      await act(async () => send.resolve("turn-1"));
      await settle();
      await act(async () => turnChange("running"));
      await settle();
      await typeKeys("рн");
      expect(stored()).toBe("черн");
      // The request card replaces the field in the middle of typing.
      await act(async () => pendingChange("pending"));
      await settle();
      expect(document.querySelector(`[aria-label="${m.sessions_chat_composer_label()}"]`)).toBeNull();
      expect(stored()).toBe("черн");
      await typeKeys("овик");
      expect(stored()).toBe("черн");
      expect(answers.length).toBe(0);
      if (close === "stop") {
        await act(async () => button(m.sessions_chat_stop()).click());
        await act(async () => {
          pendingChange("cancelled");
          turnChange("none", "cancelled");
        });
      } else {
        await act(async () => button(close).click());
        expect(answers.length).toBe(1);
        await act(async () => pendingChange("answered"));
      }
      await settle();
      expect(stored()).toBe("черн");
      expect(fieldText()).toBe("черн");
    });
  }

  function snapshot(session: AgentSessionKeyDto) {
    return {
      seq: 0,
      session,
      connection: "ready",
      turn: {
        turnId: null,
        phase: "none",
        lastOutcome: null,
        status: { state: "idle", stopReason: null, source: "svode_runtime", confidence: "exact" },
      },
      items: [],
      pending: firstPending,
      history: { source: "live", available: true, truncatedItems: null },
      writer,
      settings: [],
      commands: [],
      usage: null,
      title: null,
    };
  }

  function runCallback(id: number, data: unknown) {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
      }
    ).__TAURI_INTERNALS__.runCallback(id, data);
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
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
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
}
