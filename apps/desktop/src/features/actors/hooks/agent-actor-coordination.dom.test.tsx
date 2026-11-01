import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { AgentActorItem } from "../model/agent-actor-types";
import { useAgentActorAccessCoordinator } from "./use-agent-actor-access-coordinator";

const actor: AgentActorItem = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  binding: { agent: "codex", kind: "agent", settings: [] },
  description: "Writes documentation",
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  mode: null,
  name: "Documentation Agent",
  ownerLabel: "repo",
  ownerPath: "/repo",
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
            item: actor,
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
