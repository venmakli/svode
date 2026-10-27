import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type {
  CollectionDetailController,
  CollectionDetailRequest,
} from "@/features/collection/app-shell";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { createAgentActorDraft } from "../model/agent-actor-draft";
import type { AgentActorRow } from "../model/agent-actor-types";
import { useAgentActorAccessCoordinator } from "./use-agent-actor-access-coordinator";
import { useAgentActorDetail } from "./use-agent-actor-detail";
import type { AgentActorEditSession } from "./use-agent-actor-mutations";

const actor: AgentActorRow = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  adapters: [{ adapter: "codex", effort: null, model: null }],
  approvalMode: "ask",
  description: "Writes documentation",
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  name: "Documentation Agent",
  ownerLabel: "repo",
  ownerPath: "/repo",
  runtimeStatus: "unchecked",
};
const actorRows: readonly AgentActorRow[] = [actor];

test("same-owner create and edit intents continue without an unrelated rerender", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const access = deferred<unknown>();
  const continued: string[] = [];
  mockNativeIpc(
    (command) => {
      if (command === "repository_access_get") return access.promise;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AccessHarness onContinue={(kind) => continued.push(kind)} />,
      );
      await nextTurn();
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-request-create]")!
        .click();
      await nextTurn();
    });
    expect(continued).toEqual([]);
    expect(textOf(dom, "[data-access-requesting]")).toBe("requesting");
    expect(textOf(dom, "[data-access-recovery-open]")).toBe("closed");

    await act(async () => {
      access.resolve(localAccessSnapshot());
      await nextTurn();
      await nextTurn();
    });
    expect(continued).toEqual(["add-agent"]);
    expect(textOf(dom, "[data-access-requesting]")).toBe("idle");

    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-request-edit]")!
        .click();
      await nextTurn();
    });
    expect(continued).toEqual(["add-agent", "edit-agent"]);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("closing edit clears its session so unrelated rerenders cannot reopen it", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let latestRequest: CollectionDetailRequest | null = null;
  let openCount = 0;
  const detailController: CollectionDetailController = {
    async close() {
      return true;
    },
    async open(request) {
      latestRequest = request;
      openCount += 1;
      return true;
    },
    async update() {
      return false;
    },
  };
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<DetailHarness detailController={detailController} />);
      await nextTurn();
    });
    expect(openCount).toBe(1);
    const openedRequest = latestRequest as CollectionDetailRequest | null;
    if (!openedRequest) throw new Error("Expected edit detail to open");
    expect(typeof openedRequest.canClose).toBe("function");

    await act(async () => {
      expect(await openedRequest.canClose!()).toBe(true);
      await nextTurn();
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-unrelated-rerender]")!
        .click();
      await nextTurn();
    });
    expect(openCount).toBe(1);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("an unsaved edit waits for the asynchronous confirm of the Tauri dialog", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let latestRequest: CollectionDetailRequest | null = null;
  const detailController: CollectionDetailController = {
    async close() {
      return true;
    },
    async open(request) {
      latestRequest = request;
      return true;
    },
    async update() {
      return false;
    },
  };
  const answers = [false, true];
  const confirm = window.confirm;
  // The Tauri dialog plugin replaces window.confirm with an async function.
  window.confirm = (() =>
    Promise.resolve(answers.shift())) as unknown as typeof window.confirm;
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<DetailHarness detailController={detailController} dirty />);
      await nextTurn();
    });
    const request = latestRequest as CollectionDetailRequest | null;
    if (!request?.canClose) throw new Error("Expected edit detail to open");

    expect(await request.canClose()).toBe(false);
    await act(async () => {
      expect(await request.canClose!()).toBe(true);
      await nextTurn();
    });
  } finally {
    window.confirm = confirm;
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("an open read-only Detail follows its agent, closes once it is gone and leaves an edit form alone", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let active: CollectionDetailRequest | null = null;
  let openCount = 0;
  const detailController: CollectionDetailController = {
    async close() {
      active = null;
      return true;
    },
    async open(request) {
      active = request;
      openCount += 1;
      return true;
    },
    async update(shown, next) {
      if (active !== shown) return false;
      active = next;
      return true;
    },
  };
  const shown = () => active as CollectionDetailRequest | null;
  const titleOf = (request: CollectionDetailRequest | null) =>
    request ? renderToStaticMarkup(<>{request.title}</>) : "";
  const root = createRoot(dom.window.document.getElementById("app")!);
  const click = async (selector: string) => {
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(selector)!.click();
      await nextTurn();
    });
  };

  try {
    await act(async () => {
      root.render(
        <ReadOnlyDetailHarness detailController={detailController} />,
      );
      await nextTurn();
    });
    await click("[data-open-read-only]");
    expect(openCount).toBe(1);
    expect(shown()?.selection.rowId).toBe(
      '["/repo","01arz3ndektsv4rrffq69g5fav"]',
    );

    // A new diagnostic and an external change of the agent show in place.
    const opened = shown();
    await click("[data-publish-diagnostic]");
    expect(shown() === opened).toBe(false);
    await click("[data-rename-agent]");
    expect(titleOf(shown()).includes("Docs Agent")).toBe(true);
    expect(openCount).toBe(1);

    // An edit form of the agent is not overwritten by its changes.
    await click("[data-start-edit]");
    expect(shown()?.layout).toBe("form");
    const form = shown();
    // The form itself rerenders with its draft; the agent's changes and its
    // removal do not replace or close it.
    const formTitle = titleOf(form);
    await click("[data-rename-agent]");
    await click("[data-publish-diagnostic]");
    expect(shown()?.layout).toBe("form");
    expect(titleOf(shown())).toBe(formTitle);
    await click("[data-remove-agent]");
    expect(shown()?.layout).toBe("form");
    expect(titleOf(shown())).toBe(formTitle);
    await click("[data-restore-agent]");

    // Cancel shows the current version of the agent again.
    const footer = dom.window.document.createElement("div");
    dom.window.document.body.append(footer);
    const footerRoot = createRoot(footer);
    await act(async () => {
      footerRoot.render(<>{form?.footerActions}</>);
    });
    await act(async () => {
      footer.querySelector<HTMLButtonElement>("button")!.click();
      await nextTurn();
    });
    await act(async () => footerRoot.unmount());
    expect(shown()?.layout).toBe(undefined);
    expect(titleOf(shown()).includes("Docs Agent 2")).toBe(true);

    // A closed Detail is not reopened by later changes.
    await act(async () => {
      await detailController.close();
    });
    const opens = openCount;
    await click("[data-publish-diagnostic]");
    await click("[data-rename-agent]");
    expect(shown()).toBe(null);
    expect(openCount).toBe(opens);

    // The agent leaving the catalog closes its Detail.
    await click("[data-open-read-only]");
    expect(shown() === null).toBe(false);
    await click("[data-remove-agent]");
    expect(shown()).toBe(null);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function AccessHarness({ onContinue }: { onContinue(kind: string): void }) {
  const coordinator = useAgentActorAccessCoordinator({
    onContinue: (intent) => onContinue(intent.kind),
  });
  return (
    <>
      <button
        type="button"
        data-request-create
        onClick={() =>
          coordinator.request({ kind: "add-agent", ownerPath: "/repo" })
        }
      />
      <button
        type="button"
        data-request-edit
        onClick={() =>
          coordinator.request({
            kind: "edit-agent",
            ownerPath: "/repo",
            row: actor,
          })
        }
      />
      <span data-access-requesting>
        {coordinator.requesting ? "requesting" : "idle"}
      </span>
      <span data-access-recovery-open>
        {coordinator.recovery.open ? "open" : "closed"}
      </span>
    </>
  );
}

function DetailHarness({
  detailController,
  dirty = false,
}: {
  detailController: CollectionDetailController;
  dirty?: boolean;
}) {
  const [editSession, setEditSession] = useState<AgentActorEditSession | null>({
    draft: createAgentActorDraft(actor.ownerPath, actor),
    guard: { dirty },
    row: actor,
  });
  const [, setRenderVersion] = useState(0);
  useAgentActorDetail({
    applyMutation: () => undefined,
    descriptors: [],
    detailController,
    diagnose: () => undefined,
    diagnostics: {},
    editRuntime: {},
    editSession,
    instanceKey: "actors:space:root",
    mutationPending: false,
    pendingAdapter: null,
    rows: actorRows,
    savedRuntimeFor: () => ({}),
    setEditSession,
  });
  return (
    <button
      type="button"
      data-unrelated-rerender
      onClick={() => setRenderVersion((version) => version + 1)}
    />
  );
}

function ReadOnlyDetailHarness({
  detailController,
}: {
  detailController: CollectionDetailController;
}) {
  const [diagnostics, setDiagnostics] = useState({});
  const [rows, setRows] = useState<readonly AgentActorRow[]>([actor]);
  const [renames, setRenames] = useState(0);
  const [editSession, setEditSession] = useState<AgentActorEditSession | null>(
    null,
  );
  const selection = {
    instanceKey: "actors:space:root",
    presentationId: "agents",
    rowId: '["/repo","01arz3ndektsv4rrffq69g5fav"]',
  };
  const detail = useAgentActorDetail({
    applyMutation: () => undefined,
    descriptors: [],
    detailController,
    diagnose: () => undefined,
    diagnostics,
    editRuntime: {},
    editSession,
    instanceKey: "actors:space:root",
    mutationPending: false,
    pendingAdapter: null,
    rows,
    savedRuntimeFor: () => ({}),
    setEditSession,
  });
  const rename = () => {
    const name = renames === 0 ? "Docs Agent" : `Docs Agent ${renames + 1}`;
    setRenames(renames + 1);
    setRows([{ ...actor, name }]);
  };
  return (
    <>
      <button
        type="button"
        data-open-read-only
        onClick={() => void detail.open(rows[0] ?? actor, selection)}
      />
      <button type="button" data-rename-agent onClick={rename} />
      <button type="button" data-remove-agent onClick={() => setRows([])} />
      <button
        type="button"
        data-restore-agent
        onClick={() => setRows([{ ...actor, name: "Docs Agent 2" }])}
      />
      <button
        type="button"
        data-start-edit
        onClick={() =>
          setEditSession({
            draft: createAgentActorDraft(actor.ownerPath, rows[0] ?? actor),
            guard: { dirty: false },
            row: rows[0] ?? actor,
          })
        }
      />
      <button
        type="button"
        data-publish-diagnostic
        onClick={() =>
          setDiagnostics((current) => ({
            ...current,
            codex: {
              adapter: "codex" as const,
              authenticated: false,
              code: "adapter_unauthenticated",
              executablePath: "/bin/codex",
              message: `diagnostic-${Object.keys(current).length}`,
              status: "unauthenticated" as const,
              version: "1",
            },
          }))
        }
      />
    </>
  );
}

function localAccessSnapshot() {
  return {
    checkedAt: Date.now(),
    expiresAt: null,
    generation: 1,
    lastKnownStatus: "local",
    reason: null,
    repositoryId: "repo-test",
    status: "local",
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
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
