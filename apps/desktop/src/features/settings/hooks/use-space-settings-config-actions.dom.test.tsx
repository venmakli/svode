import { expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import {
  type SaveSpaceConfig,
  useSpaceSettingsConfigActions,
} from "./use-space-settings-config-actions";

test("saving space settings keeps the agent section of the config as it was", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const agent = {
    clis: ["claude"],
    defaultModel: "opus",
    systemPrompt: "Be brief",
    maxTurns: 5,
    maxTimeout: 60,
  };
  const saved: unknown[] = [];
  mockNativeIpc((command, args) => {
    if (command === "get_space_config")
      return { name: "Docs", icon: "book", agent };
    if (command === "save_space_config") {
      saved.push(args);
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  let saveConfig!: SaveSpaceConfig;
  function Harness() {
    const actions = useSpaceSettingsConfigActions({
      spacePath: "/project/docs",
      projectPath: "/project",
    });
    useLayoutEffect(() => {
      saveConfig = actions.saveConfig;
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => root.render(<Harness />));
    expect(await saveConfig({ name: "Renamed" })).toBe(true);
    expect(saved).toEqual([
      {
        spacePath: "/project/docs",
        configData: { name: "Renamed", icon: "book", agent },
        projectPath: "/project",
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
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
