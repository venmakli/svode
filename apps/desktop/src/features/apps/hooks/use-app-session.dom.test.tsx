import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AppManifestInspection, AppOwner } from "../model/types";

interface PendingInspection {
  owner: AppOwner;
  resolve(inspection: AppManifestInspection): void;
}

const inspections: PendingInspection[] = [];
const revoked: string[] = [];
const controls: string[] = [];
const variablesListeners = new Set<() => void>();
const mock = (
  bunTest as unknown as {
    mock: { module(specifier: string, factory: () => unknown): void };
  }
).mock;

mock.module("../api/app-api", () => ({
  controlAppProcess: (_owner: AppOwner, action: string) => {
    controls.push(action);
    return Promise.resolve({
      status: "unavailable" as const,
      ownerDirectory: "/repo/space/process",
      runtimeType: "process" as const,
      reason: "process_stopped",
      process: {
        managed: false,
        hasSetup: false,
        logs: { stdout: "", stderr: "" },
      },
    });
  },
  inspectAppManifest: (owner: AppOwner) =>
    new Promise<AppManifestInspection>((resolve) => {
      inspections.push({ owner, resolve });
    }),
  listenAppManifestChanges: () => Promise.resolve(() => undefined),
  listenAppVariablesChanged: (onChange: () => void) => {
    variablesListeners.add(onChange);
    return Promise.resolve(() => variablesListeners.delete(onChange));
  },
  revokeAppSource: (token: string) => {
    revoked.push(token);
    return Promise.resolve();
  },
}));

const { useAppSession } = await import("./use-app-session");

test("App session ignores stale resolution and revokes every static source", async () => {
  inspections.length = 0;
  revoked.length = 0;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => root.render(<Harness owner={owner("first")} />));
    expect(inspections[0]?.owner.ownerPath).toBe("first");

    await act(async () => root.render(<Harness owner={owner("second")} />));
    expect(dom.window.document.body.textContent).toBe("loading");
    expect(inspections[1]?.owner.ownerPath).toBe("second");

    await act(async () => {
      inspections[1]!.resolve(ready("second", "token-second"));
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent).toBe(
      "ready:http://127.0.0.1:42002/index.html",
    );

    await act(async () => {
      inspections[0]!.resolve(ready("first", "token-first"));
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent).toBe(
      "ready:http://127.0.0.1:42002/index.html",
    );
    expect(revoked).toEqual(["token-first"]);
  } finally {
    await act(async () => root.unmount());
    expect(revoked).toEqual(["token-first", "token-second"]);
    restoreGlobals();
    dom.window.close();
  }
});

test("navigating away from a process App does not stop its child", async () => {
  inspections.length = 0;
  revoked.length = 0;
  controls.length = 0;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => root.render(<Harness owner={owner("process")} />));
    await act(async () => {
      inspections[0]!.resolve(processReady());
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent).toBe(
      "ready:http://127.0.0.1:43000",
    );

    await act(async () => root.render(<Harness owner={owner("second")} />));
    expect(controls).toEqual([]);
    expect(revoked).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    expect(controls).toEqual([]);
    restoreGlobals();
    dom.window.close();
  }
});

test("checking an App blocked by Variables again re-inspects it with loading", async () => {
  inspections.length = 0;
  controls.length = 0;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  let retry: () => void = () => undefined;

  try {
    await act(async () =>
      root.render(
        <Harness
          owner={owner("process")}
          onSession={(session) => (retry = session.retry)}
        />,
      ),
    );
    for (const reason of [
      "unreadable_app_variables",
      "missing_app_variables",
    ] as const) {
      await act(async () => {
        inspections.at(-1)!.resolve(variablesBlocked(reason));
        await Promise.resolve();
      });
      expect(dom.window.document.body.textContent).toBe("unavailable");

      const requested = inspections.length;
      await act(async () => retry());
      expect(dom.window.document.body.textContent).toBe("loading");
      expect(inspections.length).toBe(requested + 1);
      expect(controls).toEqual([]);
    }
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("an App blocked by Variables is checked again without loading after a possible fix", async () => {
  inspections.length = 0;
  controls.length = 0;
  variablesListeners.clear();
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const text = () => dom.window.document.body.textContent;
  const render = (variablesOpen: boolean) =>
    act(async () =>
      root.render(
        <Harness owner={owner("process")} variablesOpen={variablesOpen} />,
      ),
    );
  const resolveLast = (inspection: AppManifestInspection) =>
    act(async () => {
      inspections.at(-1)!.resolve(inspection);
      await Promise.resolve();
    });

  try {
    await render(false);
    await resolveLast(variablesBlocked("unreadable_app_variables"));
    expect(variablesListeners.size).toBe(1);

    // Return to the window.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    expect(inspections.length).toBe(2);
    expect(text()).toBe("unavailable");
    await resolveLast(variablesBlocked("unreadable_app_variables"));
    expect(text()).toBe("unavailable");

    // Closing the Variables window of this App.
    await render(true);
    expect(inspections.length).toBe(2);
    await render(false);
    expect(inspections.length).toBe(3);
    expect(text()).toBe("unavailable");
    await resolveLast(variablesBlocked("missing_app_variables"));

    // A Variables change; a late answer never replaces a newer one.
    await act(async () => {
      for (const listener of variablesListeners) listener();
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    expect(inspections.length).toBe(5);
    expect(text()).toBe("unavailable");
    await act(async () => {
      inspections[4]!.resolve(processReady());
      await Promise.resolve();
    });
    expect(text()).toBe("ready:http://127.0.0.1:43000");
    await act(async () => {
      inspections[3]!.resolve(variablesBlocked("missing_app_variables"));
      await Promise.resolve();
    });
    expect(text()).toBe("ready:http://127.0.0.1:43000");
    expect(controls).toEqual([]);

    // A running App is not checked again by these triggers.
    expect(variablesListeners.size).toBe(0);
    const requested = inspections.length;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    await render(true);
    await render(false);
    expect(inspections.length).toBe(requested);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({
  owner,
  variablesOpen,
  onSession,
}: {
  owner: AppOwner;
  variablesOpen?: boolean;
  onSession?: (session: ReturnType<typeof useAppSession>) => void;
}) {
  const appSession = useAppSession(owner, variablesOpen);
  const { session } = appSession;
  onSession?.(appSession);
  return (
    <span>
      {session.status}
      {session.status === "ready" ? `:${session.viewportUrl}` : ""}
    </span>
  );
}

function owner(ownerPath: string): AppOwner {
  return {
    ownerPath,
    projectPath: "/repo",
    spaceId: "space",
    spacePath: "/repo/space",
  };
}

function ready(ownerPath: "first" | "second", capabilityToken: string) {
  return {
    status: "ready" as const,
    ownerDirectory: `/repo/space/${ownerPath}`,
    runtimeType: "static" as const,
    viewportUrl: `http://127.0.0.1:${ownerPath === "first" ? "42001" : "42002"}/index.html`,
    capabilityToken,
  };
}

function variablesBlocked(
  reason: "unreadable_app_variables" | "missing_app_variables",
): AppManifestInspection {
  return {
    status: "unavailable",
    ownerDirectory: "/repo/space/process",
    runtimeType: "process",
    reason,
    browserUrl: "http://127.0.0.1:43000",
    process: {
      managed: false,
      hasSetup: false,
      logs: { stdout: "", stderr: "" },
    },
    ...(reason === "unreadable_app_variables"
      ? {
          variablesProblem: {
            category: "legacy_format" as const,
            owner: { scope: "global" as const },
            file: "/library/settings.json",
          },
        }
      : { missingVariables: [{ referenceName: "API_URL", entryName: "API_URL" }] }),
  };
}

function processReady(): AppManifestInspection {
  return {
    status: "ready",
    ownerDirectory: "/repo/space/process",
    runtimeType: "process",
    viewportUrl: "http://127.0.0.1:43000",
    process: {
      managed: true,
      hasSetup: true,
      logs: { stdout: "ready", stderr: "" },
    },
  };
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
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
