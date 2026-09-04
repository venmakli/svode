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
const mock = (
  bunTest as unknown as {
    mock: { module(specifier: string, factory: () => unknown): void };
  }
).mock;

mock.module("../api/app-api", () => ({
  inspectAppManifest: (owner: AppOwner) =>
    new Promise<AppManifestInspection>((resolve) => {
      inspections.push({ owner, resolve });
    }),
  listenAppManifestChanges: () => Promise.resolve(() => undefined),
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

function Harness({ owner }: { owner: AppOwner }) {
  const { session } = useAppSession(owner);
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
