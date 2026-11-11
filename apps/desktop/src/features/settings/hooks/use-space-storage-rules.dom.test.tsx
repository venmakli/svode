import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { catalogFixture } from "../model/testing/variables";
import type { UseSpaceStorageSettingsResult } from "./use-space-storage-settings";

// `set_assets_strategy` replaces the saved routing with the one it gets, so
// every save of storage rules carries the `local` list.
if (process.env.SVODE_STORAGE_RULES_TEST !== "1") {
  test("storage rules save the whole routing", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_STORAGE_RULES_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 120000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  bunTest.afterAll(() => {
    restore();
    dom.window.close();
  });
  const { createRoot } = await import("react-dom/client");
  const { useSpaceStorageSettings } =
    await import("./use-space-storage-settings");

  interface Routing {
    lfsExtensions: string[];
    lfsThresholdBytes: number | null;
    localExtensions: string[];
  }

  async function setup(strategy: "local" | "lfs-remote", routing: Routing) {
    let state!: UseSpaceStorageSettingsResult;
    const saves: Record<string, unknown>[] = [];
    mockNativeIpc(
      async (command, rawArgs = {}) => {
        const args = rawArgs as Record<string, unknown>;
        switch (command) {
          case "get_assets_config":
            return {
              strategy,
              defaultS3Prefix: "default",
              inheritedFromProject: false,
              ownerSpaceId: null,
              unknownStrategy: false,
              binaryRouting: { status: "v1", version: 1, ...routing },
            };
          case "set_assets_strategy":
            saves.push(args);
            return { warnings: [] };
          case "count_assets":
            return 0;
          case "git_check_availability":
            return { git: true, gitLfs: true, gitLfsVersion: "3.7.1" };
          case "get_lfs_state":
            return "ready";
          case "diagnose_lfs_remote":
            return {
              state: "ready",
              reason: "ready",
              authMethod: "https",
              remoteUrl: null,
              terminalCommand: null,
              detail: null,
            };
          case "diagnose_lfs_policy":
            return {
              managedPolicyCurrent: true,
              uncoveredPaths: [],
              truncatedCount: 0,
              lfsDeclaration: null,
            };
          case "get_s3_bindings":
            return { bindings: null, ready: false, error: null };
          case "get_app_variables":
            return catalogFixture([]);
          default:
            throw new Error(`Unexpected command ${command}`);
        }
      },
      { shouldMockEvents: true },
    );
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const value = useSpaceStorageSettings({
        open: true,
        diagnosticsActive: false,
        spacePath: "/repo",
        projectPath: "/repo",
        currentSpaceId: null,
        isRoot: true,
      });
      useLayoutEffect(() => {
        state = value;
      });
      return null;
    }
    await act(async () => {
      root.render(<Harness />);
      await tick();
      await tick();
    });
    return {
      saves,
      get state() {
        return state;
      },
      async run(action: (state: UseSpaceStorageSettingsResult) => unknown) {
        await act(async () => {
          await action(state);
          await tick();
        });
      },
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
        clearNativeMocks();
      },
    };
  }

  test("local rules save their formats and size by applying local again", async () => {
    const h = await setup("local", {
      lfsExtensions: [],
      lfsThresholdBytes: 10_000_000,
      localExtensions: ["png", "jpg"],
    });
    try {
      expect(h.state.localExtensions).toBe("jpg, png");
      expect(h.state.lfsThresholdEnabled).toBe(true);
      expect(h.state.lfsThresholdMegabytes).toBe("10");
      expect(h.state.canUpdateLocalRules).toBe(false);

      await h.run((state) => state.setLocalExtensions("jpg, png, zip"));
      await h.run((state) => state.setLfsThresholdMegabytes("25"));
      expect(h.state.canUpdateLocalRules).toBe(true);
      await h.run((state) => state.updateLocalRules());
      expect(h.saves).toEqual([
        {
          projectPath: "/repo",
          spaceId: null,
          strategy: "local",
          binaryRouting: {
            version: 1,
            lfsExtensions: [],
            lfsThresholdBytes: 25_000_000,
            localExtensions: ["jpg", "png", "zip"],
          },
          s3Config: null,
          s3Bindings: null,
        },
      ]);
      expect(h.state.canUpdateLocalRules).toBe(false);

      // An empty list with the size rule off is saved as such, not dropped.
      await h.run((state) => state.setLocalExtensions(""));
      await h.run((state) => state.setLfsThresholdEnabled(false));
      await h.run((state) => state.updateLocalRules());
      expect(h.saves[1].binaryRouting).toEqual({
        version: 1,
        lfsExtensions: [],
        lfsThresholdBytes: null,
        localExtensions: [],
      });

      // A protected format is refused before anything is sent.
      await h.run((state) => state.setLocalExtensions("md"));
      expect(h.state.binaryRoutingIssue).toBe("protected-extension");
      expect(h.state.canUpdateLocalRules).toBe(false);
      await h.run((state) => state.updateLocalRules());
      expect(h.saves.length).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("saving LFS rules keeps the local list", async () => {
    const h = await setup("lfs-remote", {
      lfsExtensions: ["psd"],
      lfsThresholdBytes: null,
      localExtensions: ["mp4"],
    });
    try {
      await h.run((state) => state.setLfsExtensions("psd, zip"));
      expect(h.state.canUpdateLfsPolicy).toBe(true);
      await h.run((state) => state.updateLfsPolicy());
      expect(h.saves.length).toBe(1);
      expect(h.saves[0].strategy).toBe("lfs-remote");
      expect(h.saves[0].binaryRouting).toEqual({
        version: 1,
        lfsExtensions: ["psd", "zip"],
        lfsThresholdBytes: null,
        localExtensions: ["mp4"],
      });
    } finally {
      await h.cleanup();
    }
  });

  test("leaving local sends the saved local list, not an unsaved draft", async () => {
    const h = await setup("local", {
      lfsExtensions: [],
      lfsThresholdBytes: 10_000_000,
      localExtensions: ["jpg"],
    });
    try {
      await h.run((state) => state.setLocalExtensions("svg"));
      await h.run((state) => state.selectStrategy("in-git"));
      expect(h.state.binaryRoutingIssue).toBe(null);
      expect(h.state.canApplyStrategy).toBe(true);
      await h.run((state) => state.applySelectedStrategy());
      expect(h.state.pendingStrategy).toBe("in-git");
      await h.run((state) => state.confirmPendingStrategy());
      expect(h.saves.length).toBe(1);
      expect(h.saves[0].strategy).toBe("in-git");
      expect(h.saves[0].binaryRouting).toEqual({
        version: 1,
        lfsExtensions: [],
        lfsThresholdBytes: 10_000_000,
        localExtensions: ["jpg"],
      });
    } finally {
      await h.cleanup();
    }
  });
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
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
