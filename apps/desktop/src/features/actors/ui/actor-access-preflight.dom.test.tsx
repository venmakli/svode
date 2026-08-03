import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  useRepositoryAccess,
  type RepositoryAccessReason,
  type RepositoryAccessSnapshot,
  type RepositoryAccessStatus,
} from "@/features/git";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useActorAccessPreflight } from "../hooks/use-actor-access-preflight";
import type { ActorMutationIntent } from "../model/identity-mutation";
import type { ActorCatalogRow } from "../model/types";

const actor: ActorCatalogRow = {
  aliases: [],
  availableYears: [2026],
  canonicalEmail: "ada@example.test",
  commitCount: 4,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: "2026-07-31",
  lastCommitAt: 20,
  sources: [],
};

test("local and fresh writable access continue identity intents silently", async () => {
  for (const [status, action, expected] of [
    ["local", "request add", "add"],
    ["writable", "request edit", "edit:ada@example.test"],
  ] as const) {
    const harness = await renderHarness(snapshot(status));
    try {
      await clickButton(harness.dom, action);

      expect(harness.calls).toEqual(["repository_access_get"]);
      expect(textOf(harness.dom, "[data-continued]")).toBe(expected);
      expect(textOf(harness.dom, "[data-intent]")).toBe("closed");
    } finally {
      await harness.cleanup();
    }
  }
});

test("unknown access verifies explicitly and continues the selected edit intent", async () => {
  let finishVerify: ((value: RepositoryAccessSnapshot) => void) | undefined;
  const harness = await renderHarness(snapshot("unknown", "auth_required"), {
    verify: () =>
      new Promise<RepositoryAccessSnapshot>((resolve) => {
        finishVerify = resolve;
      }),
  });

  try {
    await clickButton(harness.dom, "request edit");
    expect(harness.calls).toEqual(["repository_access_get"]);
    expect(textOf(harness.dom, "[data-intent]")).toBe("edit");
    expect(textOf(harness.dom, "[data-continued]")).toBe("");

    await act(async () => {
      findButton(harness.dom, "verify")?.click();
      findButton(harness.dom, "verify again")?.click();
      await Promise.resolve();
    });
    expect(harness.calls).toEqual([
      "repository_access_get",
      "repository_access_verify",
    ]);
    expect(textOf(harness.dom, "[data-status]")).toBe("checking");
    expect(findButton(harness.dom, "verify")?.disabled).toBe(true);

    await act(async () => {
      finishVerify?.(snapshot("writable"));
      await nextTurn();
    });
    expect(textOf(harness.dom, "[data-continued]")).toBe(
      "edit:ada@example.test",
    );
    expect(textOf(harness.dom, "[data-continuation-count]")).toBe("1");
    expect(textOf(harness.dom, "[data-intent]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

test("read-only and verification failures stay actionable without losing merge intent", async () => {
  let verifyCount = 0;
  const harness = await renderHarness(snapshot("read_only"), {
    verify: () => {
      verifyCount += 1;
      if (verifyCount === 1) throw new Error("credential helper failed");
      if (verifyCount === 2) return snapshot("read_only");
      return snapshot("writable");
    },
  });

  try {
    await clickButton(harness.dom, "request merge");
    expect(textOf(harness.dom, "[data-intent]")).toBe("merge");

    await clickButton(harness.dom, "verify");
    expect(textOf(harness.dom, "[data-error]")).toBe(
      "credential helper failed",
    );
    expect(textOf(harness.dom, "[data-continued]")).toBe("");
    expect(textOf(harness.dom, "[data-intent]")).toBe("merge");

    await clickButton(harness.dom, "verify");
    expect(textOf(harness.dom, "[data-status]")).toBe("read_only");
    expect(textOf(harness.dom, "[data-continued]")).toBe("");

    await clickButton(harness.dom, "verify");
    expect(textOf(harness.dom, "[data-continued]")).toBe(
      "merge:ada@example.test",
    );
    expect(textOf(harness.dom, "[data-intent]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

test("an existing single-flight check is joined only after an identity intent", async () => {
  let finishVerify: ((value: RepositoryAccessSnapshot) => void) | undefined;
  const harness = await renderHarness(snapshot("checking"), {
    verify: () =>
      new Promise<RepositoryAccessSnapshot>((resolve) => {
        finishVerify = resolve;
      }),
  });

  try {
    expect(harness.calls).toEqual(["repository_access_get"]);
    await clickButton(harness.dom, "request add", false);
    expect(harness.calls).toEqual([
      "repository_access_get",
      "repository_access_verify",
    ]);
    expect(textOf(harness.dom, "[data-status]")).toBe("checking");

    await act(async () => {
      finishVerify?.(snapshot("local"));
      await nextTurn();
    });
    expect(textOf(harness.dom, "[data-continued]")).toBe("add");
  } finally {
    await harness.cleanup();
  }
});

test("closing preflight cancels only the current attempt", async () => {
  const harness = await renderHarness(snapshot("unknown", "expired"));
  try {
    await clickButton(harness.dom, "request add");
    expect(textOf(harness.dom, "[data-intent]")).toBe("add");

    await clickButton(harness.dom, "cancel");
    expect(textOf(harness.dom, "[data-continued]")).toBe("");
    expect(textOf(harness.dom, "[data-intent]")).toBe("closed");
    expect(harness.calls).toEqual(["repository_access_get"]);
  } finally {
    await harness.cleanup();
  }
});

function AccessPreflightHarness({ spacePath }: { spacePath: string }) {
  const access = useRepositoryAccess(spacePath);
  const [continued, setContinued] = useState("");
  const [continuationCount, setContinuationCount] = useState(0);
  const preflight = useActorAccessPreflight({
    error: access.error,
    snapshot: access.snapshot,
    verifying: access.verifying,
    onContinue: (intent) => {
      setContinued(intentValue(intent));
      setContinuationCount((current) => current + 1);
    },
    onVerify: access.verify,
  });
  const status = access.verifying
    ? "checking"
    : (access.snapshot?.status ?? "unknown");

  return (
    <>
      <button type="button" onClick={() => preflight.request({ kind: "add" })}>
        request add
      </button>
      <button
        type="button"
        onClick={() => preflight.request({ kind: "edit", source: actor })}
      >
        request edit
      </button>
      <button
        type="button"
        onClick={() => preflight.request({ kind: "merge", source: actor })}
      >
        request merge
      </button>
      <button
        type="button"
        disabled={status === "checking"}
        onClick={preflight.verify}
      >
        verify
      </button>
      <button type="button" onClick={preflight.verify}>
        verify again
      </button>
      <button type="button" onClick={preflight.close}>
        cancel
      </button>
      <span data-intent>{preflight.intent?.kind ?? "closed"}</span>
      <span data-status>{status}</span>
      <span data-error>{access.error ?? ""}</span>
      <span data-continued>{continued}</span>
      <span data-continuation-count>{continuationCount}</span>
    </>
  );
}

function intentValue(intent: ActorMutationIntent) {
  return intent.kind === "add"
    ? "add"
    : `${intent.kind}:${intent.source.canonicalEmail}`;
}

async function renderHarness(
  initialSnapshot: RepositoryAccessSnapshot,
  options: {
    verify?: () => RepositoryAccessSnapshot | Promise<RepositoryAccessSnapshot>;
  } = {},
) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  mockNativeIpc((command) => {
    calls.push(command);
    if (command === "repository_access_get") return initialSnapshot;
    if (command === "repository_access_verify") {
      return options.verify?.() ?? initialSnapshot;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  await act(async () => {
    root.render(<AccessPreflightHarness spacePath="/repo" />);
    await nextTurn();
  });

  return {
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
    dom,
  };
}

function snapshot(
  status: RepositoryAccessStatus,
  reason: RepositoryAccessReason | null = null,
): RepositoryAccessSnapshot {
  return {
    checkedAt: status === "writable" ? 1_700_000_000 : null,
    expiresAt: status === "writable" ? 1_700_086_400 : null,
    generation: 1,
    lastKnownStatus: null,
    reason,
    repositoryId: "access-repo-test",
    status,
  };
}

function findButton(dom: JSDOM, label: string) {
  return Array.from(dom.window.document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function clickButton(dom: JSDOM, label: string, flushTurn = true) {
  const button = findButton(dom, label);
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => {
    button.click();
    if (flushTurn) await nextTurn();
    else await Promise.resolve();
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
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
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
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
