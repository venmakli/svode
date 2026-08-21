import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useIdentityCheck } from "@/features/identity";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useGlobalIdentitySettings } from "./use-global-identity-settings";

test("preserves a dirty stale draft and requires explicit recovery", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let canonical = identity("Alice", "alice@example.test", "v1");
  mockNativeIpc(
    (command) => {
      if (command === "get_git_identity") return canonical;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<GlobalIdentitySettingsHarness />);
      await nextTurn();
      await nextTurn();
    });
    expect(valueOf(dom, "[data-name]")).toBe("Alice");

    await clickAndFlush(dom, "[data-edit]");
    const nameInput = dom.window.document.querySelector<HTMLInputElement>(
      "[data-name]",
    )!;
    Object.assign(nameInput, {
      attachEvent: () => undefined,
      detachEvent: () => undefined,
    });
    nameInput.focus();
    canonical = identity("Bob", "bob@example.test", "v2");
    await act(async () => {
      await emitNativeEvent("git-identity:global-changed");
      await nextTurn();
      await nextTurn();
    });

    expect(valueOf(dom, "[data-name]")).toBe("Draft");
    expect(textOf(dom, "[data-stale]")).toBe("stale");
    expect(textOf(dom, "[data-can-save]")).toBe("blocked");
    expect(dom.window.document.activeElement).toBe(nameInput);

    await clickAndFlush(dom, "[data-use-latest]");
    expect(valueOf(dom, "[data-name]")).toBe("Bob");
    expect(textOf(dom, "[data-stale]")).toBe("current");

    canonical = identity("Carol", "carol@example.test", "v3");
    await act(async () => {
      await emitNativeEvent("git-identity:global-changed");
      await nextTurn();
      await nextTurn();
    });
    expect(valueOf(dom, "[data-name]")).toBe("Carol");
    expect(textOf(dom, "[data-stale]")).toBe("current");

    await clickAndFlush(dom, "[data-edit]");
    canonical = identity("Dave", "dave@example.test", "v4");
    await act(async () => {
      await emitNativeEvent("git-identity:global-changed");
      await nextTurn();
      await nextTurn();
    });
    expect(valueOf(dom, "[data-name]")).toBe("Draft");
    expect(textOf(dom, "[data-stale]")).toBe("stale");

    await clickAndFlush(dom, "[data-keep-draft]");
    expect(valueOf(dom, "[data-name]")).toBe("Draft");
    expect(textOf(dom, "[data-stale]")).toBe("current");
    expect(textOf(dom, "[data-can-save]")).toBe("ready");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function GlobalIdentitySettingsHarness() {
  useIdentityCheck();
  const settings = useGlobalIdentitySettings(true);
  return (
    <>
      <input data-name value={settings.identityName} readOnly />
      <span data-stale>{settings.identityStale ? "stale" : "current"}</span>
      <span data-can-save>{settings.canSaveIdentity ? "ready" : "blocked"}</span>
      <button
        type="button"
        data-edit
        onClick={() => {
          settings.setIdentityName("Draft");
          settings.setIdentityEmail("draft@example.test");
        }}
      />
      <button
        type="button"
        data-use-latest
        onClick={settings.handleUseLatestIdentity}
      />
      <button
        type="button"
        data-keep-draft
        onClick={settings.handleKeepIdentityDraft}
      />
    </>
  );
}

function identity(name: string, email: string, fingerprint: string) {
  return {
    global: { name, email },
    source: "global" as const,
    fingerprint,
  };
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

async function clickAndFlush(dom: JSDOM, selector: string) {
  await act(async () => {
    dom.window.document.querySelector<HTMLButtonElement>(selector)!.click();
    await nextTurn();
  });
}

function valueOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector<HTMLInputElement>(selector)?.value ?? "";
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
