import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { RepositoryAccessTarget } from "@/features/git";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

let useRepositoryAccessPreflight: typeof import("../hooks/use-repository-access-preflight").useRepositoryAccessPreflight;
let RepositoryAccessInlineRecovery: typeof import("./repository-access-preflight").RepositoryAccessInlineRecovery;

test("automatic local reread stays hidden until a blocker is confirmed", async () => {
  let finishLoad: ((value: ReturnType<typeof snapshot>) => void) | undefined;
  const harness = await renderHarness({
    load: () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
    paths: new Map(),
    verify: () => snapshot("repo-normal", "writable"),
  });

  try {
    await click(harness.dom, "[data-request-normal]", false);
    expect(textOf(harness.dom, "[data-pending]")).toBe("pending");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
    expect(
      harness.dom.window.document.querySelector(
        "[data-repository-access-inline-recovery]",
      ),
    ).toBeNull();
    expect(textOf(harness.dom, "[data-continued]")).toBe("0");

    await act(async () => {
      finishLoad?.(snapshot("repo-normal", "local"));
      await nextTurn();
    });
    expect(textOf(harness.dom, "[data-pending]")).toBe("idle");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
  } finally {
    await harness.cleanup();
  }
});

test("single-target preflight stays silent for normal access and continues once after explicit verification", async () => {
  let finishVerify: ((value: ReturnType<typeof snapshot>) => void) | undefined;
  const harness = await renderHarness({
    paths: new Map([
      ["/normal", snapshot("repo-normal", "local")],
      ["/blocked", snapshot("repo-blocked", "unknown", "not_checked")],
    ]),
    verify: (path) =>
      path === "/blocked"
        ? new Promise((resolve) => {
            finishVerify = resolve;
          })
        : snapshot("repo-normal", "local"),
  });

  try {
    await click(harness.dom, "[data-request-normal]");
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");

    await click(harness.dom, "[data-request-blocked]");
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
    expect(textOf(harness.dom, "[data-blocker-count]")).toBe("1");
    expect(
      Boolean(
        harness.dom.window.document.querySelector(
          "[data-repository-access-inline-recovery]",
        ),
      ),
    ).toBe(true);

    await act(async () => {
      harness.dom.window.document
        .querySelector<HTMLButtonElement>("[data-run-primary]")!
        .click();
      harness.dom.window.document
        .querySelector<HTMLButtonElement>("[data-run-primary]")!
        .click();
      await Promise.resolve();
    });
    expect(
      harness.calls.filter((command) => command === "repository_access_verify")
        .length,
    ).toBe(1);

    await act(async () => {
      finishVerify?.(snapshot("repo-blocked", "writable"));
      await nextTurn();
    });
    expect(textOf(harness.dom, "[data-continued]")).toBe("2");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

test("multi-repository preflight deduplicates identities and never starts a partial continuation", async () => {
  const paths = new Map([
    ["/repo-a", snapshot("repo-a", "unknown", "expired")],
    ["/repo-a-alias", snapshot("repo-a", "unknown", "expired")],
    ["/repo-b", snapshot("repo-b", "unknown", "offline_or_timeout")],
  ]);
  const harness = await renderHarness({
    paths,
    verify: (path) => {
      const repositoryId = path.startsWith("/repo-a") ? "repo-a" : "repo-b";
      const next = snapshot(repositoryId, "writable");
      for (const candidate of paths.keys()) {
        if (
          (repositoryId === "repo-a" && candidate.startsWith("/repo-a")) ||
          candidate === "/repo-b"
        ) {
          paths.set(candidate, next);
        }
      }
      return next;
    },
  });

  try {
    await click(harness.dom, "[data-request-multi]");
    expect(textOf(harness.dom, "[data-blocker-count]")).toBe("2");
    expect(textOf(harness.dom, "[data-continued]")).toBe("0");
    const blockers = harness.dom.window.document.querySelectorAll(
      "[data-repository-access-blocker]",
    );
    expect(blockers.length).toBe(2);
    expect(
      harness.dom.window.document.body.textContent?.includes("Repo A"),
    ).toBe(true);
    expect(
      harness.dom.window.document.body.textContent?.includes("Repo B"),
    ).toBe(true);

    await click(harness.dom, "[data-run-primary]");
    expect(
      harness.calls.filter((command) => command === "repository_access_verify")
        .length,
    ).toBe(2);
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

test("late typed denial refreshes only the exact repository and requires an explicit retry", async () => {
  const paths = new Map([
    ["/late-a", snapshot("late-a", "local")],
    ["/late-b", snapshot("late-b", "local")],
  ]);
  const harness = await renderHarness({
    paths,
    verify: (path) => {
      const next = snapshot(
        path === "/late-a" ? "late-a" : "late-b",
        "writable",
      );
      paths.set(path, next);
      return next;
    },
  });

  try {
    await click(harness.dom, "[data-request-late-base]");
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
    const readsBefore = accessReads(harness.calls);
    paths.set("/late-a", snapshot("late-a", "unknown", "expired"));

    await click(harness.dom, "[data-recover-late]");
    expect(accessReads(harness.calls)).toEqual({
      "/late-a": readsBefore["/late-a"] + 1,
      "/late-b": readsBefore["/late-b"],
    });
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");
    expect(textOf(harness.dom, "[data-blocker-count]")).toBe("1");

    await click(harness.dom, "[data-run-primary]");
    expect(textOf(harness.dom, "[data-ready-retry]")).toBe("ready");
    expect(textOf(harness.dom, "[data-continued]")).toBe("1");

    await click(harness.dom, "[data-run-primary]");
    expect(textOf(harness.dom, "[data-continued]")).toBe("2");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

test("plan drift returns to domain review and cancel invalidates a pending single-flight continuation", async () => {
  let finishVerify: ((value: ReturnType<typeof snapshot>) => void) | undefined;
  const harness = await renderHarness({
    paths: new Map([["/checking", snapshot("checking", "checking")]]),
    verify: () =>
      new Promise((resolve) => {
        finishVerify = resolve;
      }),
  });

  try {
    await click(harness.dom, "[data-request-checking]", false);
    await nextTurn();
    expect(
      harness.calls.filter((command) => command === "repository_access_verify")
        .length,
    ).toBe(1);
    await click(harness.dom, "[data-close]");
    await act(async () => {
      finishVerify?.(snapshot("checking", "writable"));
      await nextTurn();
    });
    expect(textOf(harness.dom, "[data-continued]")).toBe("0");

    await click(harness.dom, "[data-plan-changed]");
    expect(textOf(harness.dom, "[data-plan-changed-count]")).toBe("1");
    expect(textOf(harness.dom, "[data-open]")).toBe("closed");
  } finally {
    await harness.cleanup();
  }
});

function RecoveryHarness() {
  const recovery = useRepositoryAccessPreflight();
  const [continued, setContinued] = useState(0);
  const [planChanged, setPlanChanged] = useState(0);
  const continueIntent = () => setContinued((current) => current + 1);
  const request = (
    intentKey: string,
    targets: readonly RepositoryAccessTarget[],
  ) =>
    recovery.request({
      continuation: "automatic",
      continue: continueIntent,
      intentKey,
      intentLabel: "Save changes",
      placement: "inline",
      targets,
    });
  const lateTargets = [
    target("/late-a", "Late A"),
    target("/late-b", "Late B"),
  ];

  return (
    <>
      <button
        data-request-normal
        onClick={() => void request("normal", [target("/normal", "Normal")])}
      />
      <button
        data-request-blocked
        onClick={() => void request("blocked", [target("/blocked", "Blocked")])}
      />
      <button
        data-request-multi
        onClick={() =>
          void request("multi", [
            target("/repo-a", "Repo A"),
            target("/repo-a-alias", "Repo A alias"),
            target("/repo-b", "Repo B"),
          ])
        }
      />
      <button
        data-request-late-base
        onClick={() => void request("late-base", lateTargets)}
      />
      <button
        data-request-checking
        onClick={() =>
          void request("checking", [target("/checking", "Checking")])
        }
      />
      <button
        data-recover-late
        onClick={() =>
          void recovery.recoverFromError(
            denial("late-a", "unknown", "expired"),
            {
              continuation: "explicit",
              continue: continueIntent,
              intentKey: "late-retry",
              intentLabel: "Save changes",
              placement: "inline",
              targets: lateTargets,
            },
          )
        }
      />
      <button
        data-plan-changed
        onClick={() =>
          void recovery.recoverFromError(
            denial("checking", "unknown", "mutation_plan_changed"),
            {
              continuation: "explicit",
              continue: continueIntent,
              intentKey: "plan-change",
              intentLabel: "Save changes",
              onPlanChanged: () => setPlanChanged((current) => current + 1),
              placement: "inline",
              targets: [target("/checking", "Checking")],
            },
          )
        }
      />
      <button data-run-primary onClick={recovery.runPrimaryAction} />
      <button data-close onClick={recovery.close} />
      <span data-open>{recovery.open ? "open" : "closed"}</span>
      <span data-pending>{recovery.pending ? "pending" : "idle"}</span>
      <span data-blocker-count>{recovery.blockers.length}</span>
      <span data-ready-retry>
        {recovery.readyToRetry ? "ready" : "blocked"}
      </span>
      <span data-continued>{continued}</span>
      <span data-plan-changed-count>{planChanged}</span>
      <RepositoryAccessInlineRecovery recovery={recovery} />
    </>
  );
}

async function renderHarness({
  load,
  paths,
  verify,
}: {
  load?(
    path: string,
  ): ReturnType<typeof snapshot> | Promise<ReturnType<typeof snapshot>>;
  paths: Map<string, ReturnType<typeof snapshot>>;
  verify(
    path: string,
  ): ReturnType<typeof snapshot> | Promise<ReturnType<typeof snapshot>>;
}) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "repository_access_get") {
        const path = String((args as Record<string, unknown>).spacePath);
        calls.push(`${command}:${path}`);
        if (load) return load(path);
        return (
          paths.get(path) ??
          snapshot(`missing:${path}`, "unknown", "not_checked")
        );
      }
      if (command === "repository_access_verify") {
        const path = String((args as Record<string, unknown>).spacePath);
        calls.push(command);
        return verify(path);
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  ({ useRepositoryAccessPreflight } =
    await import("../hooks/use-repository-access-preflight"));
  ({ RepositoryAccessInlineRecovery } =
    await import("./repository-access-preflight"));
  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(<RecoveryHarness />);
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

function target(
  repositoryPath: string,
  displayName: string,
): RepositoryAccessTarget {
  return { displayName, displayPath: repositoryPath, repositoryPath };
}

function snapshot(
  repositoryId: string,
  status: "local" | "checking" | "writable" | "read_only" | "unknown",
  reason: "not_checked" | "offline_or_timeout" | "expired" | null = null,
) {
  return {
    checkedAt: status === "writable" ? 1_700_000_000 : null,
    expiresAt: status === "writable" ? 1_700_086_400 : null,
    generation: 1,
    lastKnownStatus: null,
    reason,
    repositoryId,
    status,
  };
}

function denial(
  repositoryId: string,
  status: "unknown",
  reason: "expired" | "mutation_plan_changed",
) {
  return {
    cause: {
      kind: "repository_access_denied",
      reason,
      repositoryId,
      status,
    },
  };
}

function accessReads(calls: readonly string[]) {
  return Object.fromEntries(
    ["/late-a", "/late-b"].map((path) => [
      path,
      calls.filter((call) => call === `repository_access_get:${path}`).length,
    ]),
  );
}

async function click(dom: JSDOM, selector: string, flush = true) {
  const button = dom.window.document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Button not found: ${selector}`);
  await act(async () => {
    button.click();
    if (flush) await nextTurn();
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
