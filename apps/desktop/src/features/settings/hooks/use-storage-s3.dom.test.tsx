import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { emit } from "@/platform/native/events";
import { variableFixture, catalogFixture } from "../model/testing/variables";
import type { VariableSource } from "../model/app-variables";
import type { AppVariableEntry } from "../model";
import type { UseSpaceStorageSettingsResult } from "./use-space-storage-settings";

if (process.env.SVODE_S3_TEST !== "1") {
  (test as (name: string, run: () => void, timeout: number) => void)(
    "Storage S3 DOM and async lifecycle",
    () => {
      const child = spawnSync(
        process.execPath,
        ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
        { env: { ...process.env, SVODE_S3_TEST: "1" }, encoding: "utf8" },
      );
      if (child.status !== 0) throw new Error(child.stdout + child.stderr);
      expect(child.status).toBe(0);
    },
    120000,
  );
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  (bunTest as typeof bunTest & { afterAll(run: () => void): void }).afterAll(
    () => {
      restore();
      dom.window.close();
    },
  );
  const { createRoot } = await import("react-dom/client");
  const { useSpaceStorageSettings } =
    await import("./use-space-storage-settings");
  const { StorageS3Fields } = await import("../ui/storage-s3-fields");
  const spaces: [] = [];
  const target = {
    endpoint: "https://s3.test",
    bucket: "existing",
    region: "region",
    prefix: "same/objects",
  };
  const event = "app-settings:variables-changed";

  async function setup(saved = false, strategy: "local" | "lfs-s3" = "lfs-s3") {
    let state!: UseSpaceStorageSettingsResult;
    const fixture = {
      entries: [
        { name: "ACCESS", kind: "secret", hasValue: true, usedIn: [] },
        {
          name: "SECRET",
          kind: "secret",
          hasValue: true,
          usedIn: [{ ownerDirectory: "/repo/app", referenceName: "TOKEN" }],
        },
        {
          name: "PLAIN",
          kind: "variable",
          hasValue: true,
          value: "plain",
          usedIn: [],
        },
      ].map((e) =>
        variableFixture(
          { ...e, kind: e.kind as "secret" | "variable" },
          { scope: "library" },
        ),
      ) as AppVariableEntry[],
      bindings: saved ? { accessKey: "ACCESS", secretKey: "SECRET" } : null,
      calls: [] as { command: string; args: Record<string, unknown> }[],
      failSave: false,
      failCatalog: false,
      checkGate: null as Promise<void> | null,
      mutationGate: null as Promise<void> | null,
      bindingGate: null as Promise<void> | null,
    };
    mockNativeIpc(
      async (command, rawArgs = {}) => {
        const args = rawArgs as Record<string, unknown>;
        if (command === "get_assets_config")
          return {
            strategy,
            s3: target,
            defaultS3Prefix: "default",
            inheritedFromProject: args.spaceId === "inline",
            ownerSpaceId: args.spaceId === "inline" ? null : args.spaceId,
            gitType: args.spaceId === "inline" ? "inline" : null,
            binaryRouting: {
              status: "v1",
              version: 1,
              lfsExtensions: ["png"],
              lfsThresholdBytes: null,
            },
          };
        if (command === "count_assets") return 0;
        if (command === "git_check_availability")
          return { git: true, gitLfs: true };
        if (command === "get_lfs_state")
          return fixture.bindings &&
            Object.values(fixture.bindings).every((name) =>
              fixture.entries.some(
                (entry) =>
                  entry.name === name &&
                  entry.kind === "secret" &&
                  entry.hasValue,
              ),
            )
            ? "ready"
            : "missing-creds";
        if (command === "diagnose_lfs_policy")
          return {
            managedPolicyCurrent: true,
            uncoveredPaths: [],
            truncatedCount: 0,
          };
        if (command === "get_s3_bindings") {
          const snapshot = args.spaceId === "other" ? null : fixture.bindings;
          await fixture.bindingGate;
          return {
            bindings: snapshot,
            ready: !!snapshot,
            error: snapshot ? null : "Configure S3 again",
          };
        }
        if (command === "get_app_variables") {
          if (fixture.failCatalog) throw new Error("Keychain denied");
          return catalogFixture(structuredClone(fixture.entries), {
            scope: "library",
          });
        }
        if (command === "upsert_app_variable") {
          fixture.calls.push({ command, args });
          await fixture.mutationGate;
          const input = args.input as {
            source: VariableSource;
            identity?: string;
            kind: "secret";
            value?: string;
          };
          const existing = fixture.entries.find(
            (item) => item.name === input.source.name,
          );
          if (!input.identity && existing) throw new Error("collision");
          if (Boolean(input.identity) && existing?.kind !== "secret")
            throw new Error("changed");
          if (!existing)
            fixture.entries.push(
              variableFixture(
                {
                  name: input.source.name,
                  kind: "secret",
                  hasValue: true,
                  usedIn: [],
                },
                { scope: "library" },
              ),
            );
          return;
        }
        if (command === "check_s3_bindings") {
          fixture.calls.push({ command, args });
          await fixture.checkGate;
          return true;
        }
        if (command === "set_assets_strategy") {
          fixture.calls.push({ command, args });
          if (fixture.failSave) throw new Error("write failed");
          fixture.bindings = args.s3Bindings as typeof fixture.bindings;
          await emit(event);
          return { warnings: [] };
        }
        throw new Error(`Unexpected command ${command}`);
      },
      { shouldMockEvents: true },
    );
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    function Harness({
      spaceId = null,
      open = true,
    }: {
      spaceId?: string | null;
      open?: boolean;
    }) {
      const value = useSpaceStorageSettings({
        open,
        diagnosticsActive: false,
        spacePath: "/repo",
        projectPath: "/repo",
        currentSpaceId: spaceId,
        isRoot: !spaceId,
        spaces,
      });
      useLayoutEffect(() => {
        state = value;
      });
      return <StorageS3Fields settings={value} canSave={value.canSaveS3} />;
    }
    async function render(spaceId: string | null = null, open = true) {
      await act(async () => {
        root.render(<Harness spaceId={spaceId} open={open} />);
        await tick();
        await tick();
      });
    }
    await render();
    return {
      fixture,
      get state() {
        return state;
      },
      container,
      render,
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
        clearNativeMocks();
      },
    };
  }

  test("old target survives; draft check and failed save retry reuse explicitly created Secrets", async () => {
    const h = await setup();
    try {
      expect(h.state.s3Prefix).toBe("same/objects");
      expect(h.state.s3.bindings.accessKey).toBe("");
      expect(h.state.canSaveS3).toBe(false);
      await act(async () => {
        h.state.s3.begin("accessKey", false);
      });
      await act(async () => {
        h.state.s3.updateDraft({
          ...h.state.s3.editor!.draft,
          name: "NEW_ACCESS",
          value: "private-test-value",
        });
      });
      await act(async () => {
        await h.state.s3.submit();
      });
      expect(h.state.s3.bindings.accessKey).toBe("NEW_ACCESS");
      expect(h.fixture.bindings).toBe(null);
      await act(async () => h.state.s3.select("secretKey", "SECRET"));
      await act(async () => {
        await h.state.testS3();
      });
      expect(h.state.s3.testState).toBe("ok");
      const check = h.fixture.calls.find(
        (call) => call.command === "check_s3_bindings",
      )!;
      expect(check.args.bindings).toEqual({
        accessKey: "NEW_ACCESS",
        secretKey: "SECRET",
      });
      expect(JSON.stringify(check.args).includes("private-test-value")).toBe(
        false,
      );
      h.fixture.failSave = true;
      await act(async () => {
        await h.state.saveS3();
      });
      expect(h.fixture.bindings).toBe(null);
      expect(h.state.s3.bindings.accessKey).toBe("NEW_ACCESS");
      h.fixture.failSave = false;
      await act(async () => {
        await h.state.saveS3();
        await tick();
      });
      expect(h.fixture.bindings?.accessKey).toBe("NEW_ACCESS");
      expect(
        h.fixture.calls.filter((call) => call.command === "upsert_app_variable")
          .length,
      ).toBe(1);
      expect(
        JSON.stringify(
          h.fixture.calls.filter(
            (call) => call.command === "set_assets_strategy",
          ),
        ).includes("private-test-value"),
      ).toBe(false);
      await h.render(null, false);
      await h.render();
      expect(h.state.s3.bindings.accessKey).toBe("NEW_ACCESS");
      await act(async () => {
        await h.state.testS3();
      });
      expect(h.state.s3.testState).toBe("ok");
      expect(
        h.container.querySelectorAll('input[type="password"]').length,
      ).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("fixed Secret editor preserves blank values, collision, draft and cancel focus", async () => {
    const h = await setup(true);
    try {
      const edit = Array.from(
        h.container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === "Edit")!;
      await act(async () => edit.click());
      expect(h.state.canSaveS3).toBe(false);
      expect(h.container.querySelectorAll("form").length).toBe(1);
      expect(h.container.querySelector('[data-slot="toggle-group"]')).toBe(
        null,
      );
      expect(h.state.s3.editor!.draft.value).toBe("");
      await act(async () => {
        await h.state.s3.submit();
      });
      const write = h.fixture.calls.find(
        (call) => call.command === "upsert_app_variable",
      )!;
      expect((write.args.input as Record<string, unknown>).value).toBe(
        undefined,
      );
      await act(async () => {
        h.state.s3.begin("secretKey", false);
      });
      await act(async () => {
        h.state.s3.updateDraft({
          ...h.state.s3.editor!.draft,
          name: "PLAIN",
          value: "draft",
        });
      });
      expect(h.state.s3.collision).toBe(true);
      expect(h.state.s3.canSubmit).toBe(false);
      await act(async () => {
        await emit(event);
        await tick();
      });
      expect(h.state.s3.editor!.draft.value).toBe("draft");
      await act(async () => {
        h.state.s3.cancel();
      });
      await act(async () => edit.click());
      await act(async () => {
        h.container.querySelector("form")!.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(h.state.s3.editor).toBe(null);
      expect(dom.window.document.activeElement).toBe(edit);
    } finally {
      await h.cleanup();
    }
  });

  test("rotation/kind changes invalidate checks; late check cannot verify changed target", async () => {
    const h = await setup(true);
    try {
      await act(async () => {
        await h.state.testS3();
      });
      expect(h.state.s3.testState).toBe("ok");
      await act(async () => {
        await emit(event);
        await tick();
      });
      expect(h.state.s3.testState).toBe("idle");
      const gate = deferred();
      h.fixture.checkGate = gate.promise;
      let checking!: Promise<void>;
      await act(async () => {
        checking = h.state.testS3();
      });
      await act(async () => {
        h.state.setS3Bucket("new-target");
      });
      await act(async () => {
        gate.resolve();
        await checking;
      });
      expect(h.state.s3.testState).toBe("idle");
      expect(h.state.s3.bindings.secretKey).toBe("SECRET");
      await act(async () => {
        h.fixture.entries.find((item) => item.name === "SECRET")!.kind =
          "variable";
        await emit(event);
        await tick();
      });
      expect(h.state.canSaveS3).toBe(false);
      expect(h.container.textContent!.includes("different type")).toBe(true);
      expect(h.state.lfsState).toBe("missing-creds");
      await act(async () => {
        h.fixture.entries.find((item) => item.name === "SECRET")!.kind =
          "secret";
        await emit(event);
        await tick();
      });
      expect(h.state.canSaveS3).toBe(true);
      await act(async () => {
        h.state.setS3Prefix("new-prefix");
      });
      expect(h.state.s3.bindings.secretKey).toBe("SECRET");
    } finally {
      await h.cleanup();
    }
  });

  test("pending writes block repeats/cancel; late old owner completion preserves current bindings", async () => {
    const h = await setup(true);
    try {
      await act(async () => {
        h.state.s3.begin("secretKey", true);
      });
      const gate = deferred();
      h.fixture.mutationGate = gate.promise;
      let saving!: Promise<boolean>;
      await act(async () => {
        saving = h.state.s3.submit();
      });
      expect(h.state.s3.pending).toBe(true);
      expect(h.state.s3.cancel()).toBe(false);
      await act(async () => {
        await h.state.s3.submit();
      });
      expect(
        h.fixture.calls.filter((call) => call.command === "upsert_app_variable")
          .length,
      ).toBe(1);
      await h.render("other");
      await act(async () => {
        gate.resolve();
        await saving;
      });
      expect(h.state.s3.editor).toBe(null);
      expect(h.state.s3.bindings.secretKey).toBe("");
      expect(h.state.s3.pending).toBe(false);
      await h.render("inline");
      expect(h.state.canSaveS3).toBe(false);
      await act(async () => {
        h.state.s3.begin("secretKey", false);
      });
      expect(h.state.s3.editor).toBe(null);
    } finally {
      await h.cleanup();
    }
  });

  test("catalog failure/retry keeps the selected pair and editor input; late owner reads are ignored", async () => {
    const h = await setup(true);
    try {
      await act(async () => {
        h.state.s3.select("accessKey", "SECRET");
      });
      await act(async () => {
        h.state.s3.begin("secretKey", true);
      });
      await act(async () => {
        h.state.s3.updateDraft({
          ...h.state.s3.editor!.draft,
          value: "unsaved",
        });
      });
      h.fixture.failCatalog = true;
      await act(async () => {
        await emit(event);
        await tick();
      });
      expect(h.state.s3.variables.loadError).toBe(true);
      expect(h.state.canSaveS3).toBe(false);
      expect(h.container.querySelector('input[type="password"]') !== null).toBe(
        true,
      );
      h.fixture.failCatalog = false;
      await act(async () => {
        h.state.s3.retry();
        await tick();
      });
      expect(h.state.s3.bindings.accessKey).toBe("SECRET");
      expect(h.state.s3.editor!.draft.value).toBe("unsaved");
      const gate = deferred();
      h.fixture.bindingGate = gate.promise;
      await act(async () => {
        await emit(event);
      });
      await h.render("other");
      expect(h.state.s3.loaded).toBe(false);
      await act(async () => {
        gate.resolve();
        await tick();
      });
      expect(h.state.s3.bindings.secretKey).toBe("");
    } finally {
      await h.cleanup();
    }
  });

  test("new S3 strategy binds only after confirmation and preserves selected owner", async () => {
    const h = await setup(false, "local");
    try {
      await h.render("repo-space");
      await act(async () => {
        await h.state.selectStrategy("lfs-s3");
      });
      await act(async () => {
        h.state.s3.select("accessKey", "ACCESS");
        h.state.s3.select("secretKey", "SECRET");
      });
      expect(h.state.canSaveS3).toBe(true);
      await act(async () => {
        await h.state.saveS3();
      });
      expect(h.state.pendingStrategy).toBe("lfs-s3");
      expect(h.fixture.bindings).toBe(null);
      await act(async () => {
        await h.state.confirmPendingStrategy();
      });
      const save = h.fixture.calls.find(
        (call) => call.command === "set_assets_strategy",
      )!;
      expect(save.args.spaceId).toBe("repo-space");
      expect(save.args.s3Config).toEqual(target);
      expect(save.args.s3Bindings).toEqual({
        accessKey: "ACCESS",
        secretKey: "SECRET",
      });
    } finally {
      await h.cleanup();
    }
  });
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    CustomEvent: dom.window.CustomEvent,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLOptionElement: dom.window.HTMLOptionElement,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
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
