import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  SystemCollectionDetailController,
  SystemCollectionDetailRequest,
} from "@/features/collection/system";
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

    await act(async () => {
      access.resolve(localAccessSnapshot());
      await nextTurn();
      await nextTurn();
    });
    expect(continued).toEqual(["add-agent"]);

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
  let latestRequest: SystemCollectionDetailRequest | null = null;
  let openCount = 0;
  const detailController: SystemCollectionDetailController = {
    async close() {
      return true;
    },
    async open(request) {
      latestRequest = request;
      openCount += 1;
      return true;
    },
    async prepareForNavigation() {
      return true;
    },
  };
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<DetailHarness detailController={detailController} />);
      await nextTurn();
    });
    expect(openCount).toBe(1);
    const openedRequest = latestRequest as SystemCollectionDetailRequest | null;
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

test("an open read-only Detail receives current diagnostics without reopening after close", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let latestRequest: SystemCollectionDetailRequest | null = null;
  let openCount = 0;
  const detailController: SystemCollectionDetailController = {
    async close() {
      return true;
    },
    async open(request) {
      latestRequest = request;
      openCount += 1;
      return true;
    },
    async prepareForNavigation() {
      return true;
    },
  };
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <ReadOnlyDetailHarness detailController={detailController} />,
      );
      await nextTurn();
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-open-read-only]")!
        .click();
      await nextTurn();
    });
    expect(openCount).toBe(1);

    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-publish-diagnostic]")!
        .click();
      await nextTurn();
    });
    expect(openCount).toBe(2);
    const refreshedRequest =
      latestRequest as SystemCollectionDetailRequest | null;
    if (!refreshedRequest) throw new Error("Expected refreshed detail request");
    expect(refreshedRequest.selection.rowId).toBe(
      '["/repo","01arz3ndektsv4rrffq69g5fav"]',
    );

    await act(async () => {
      expect(await refreshedRequest.canClose?.()).toBe(true);
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-publish-diagnostic]")!
        .click();
      await nextTurn();
    });
    expect(openCount).toBe(2);
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
    </>
  );
}

function DetailHarness({
  detailController,
}: {
  detailController: SystemCollectionDetailController;
}) {
  const [editSession, setEditSession] = useState<AgentActorEditSession | null>({
    draft: createAgentActorDraft(actor.ownerPath, actor),
    guard: { dirty: false },
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
  detailController: SystemCollectionDetailController;
}) {
  const [diagnostics, setDiagnostics] = useState({});
  const createDetail = useAgentActorDetail({
    applyMutation: () => undefined,
    descriptors: [],
    detailController,
    diagnose: () => undefined,
    diagnostics,
    editRuntime: {},
    editSession: null,
    instanceKey: "actors:space:root",
    mutationPending: false,
    pendingAdapter: null,
    savedRuntimeFor: () => ({}),
    setEditSession: () => undefined,
  });
  return (
    <>
      <button
        type="button"
        data-open-read-only
        onClick={() =>
          void detailController.open({
            ...createDetail(actor),
            selection: {
              instanceKey: "actors:space:root",
              presentationId: "agents",
              rowId: '["/repo","01arz3ndektsv4rrffq69g5fav"]',
            },
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
