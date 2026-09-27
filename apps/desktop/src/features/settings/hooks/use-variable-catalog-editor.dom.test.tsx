import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { catalogFixture, variableFixture } from "../model/testing/variables";
import type {
  AppVariableEntry,
  VariableMutationResult,
  VariableScope,
} from "../model/app-variables";

if (process.env.SVODE_CATALOG_GIT_TEST !== "1") {
  (test as (name: string, run: () => void, timeout: number) => void)(
    "Variables catalog Git outcomes and recovery",
    () => {
      const child = spawnSync(
        process.execPath,
        ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, SVODE_CATALOG_GIT_TEST: "1" },
          encoding: "utf8",
        },
      );
      if (child.status !== 0) throw new Error(child.stdout + child.stderr);
      expect(child.status).toBe(0);
    },
    120000,
  );
} else {
  test("published mutations close drafts for commit, skip and failure; recovery reports its own attempt", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="app"></div></body></html>',
      { pretendToBeVisual: true, url: "http://localhost/" },
    );
    const restore = installDomGlobals(dom);
    const { createRoot } = await import("react-dom/client");
    const { useVariableCatalogEditor } =
      await import("./use-variable-catalog-editor");
    const scope: VariableScope = { projectPath: "/repo", spaceId: null };
    let state!: ReturnType<typeof useVariableCatalogEditor>;
    let result: VariableMutationResult & { completed?: boolean } = {
      effects: [],
    };
    let failWrite = false;
    let failRecovery = false;
    const entries: AppVariableEntry[] = [];
    const calls: string[] = [];
    mockNativeIpc(
      (command, args) => {
        if (command === "get_app_variables")
          return catalogFixture(structuredClone(entries));
        calls.push(command);
        if (command === "upsert_app_variable") {
          if (failWrite) throw new Error("write failed");
          const input = (args as { input: unknown }).input as {
            source: { name: string };
            value: string;
          };
          entries.push(
            variableFixture({
              name: input.source.name,
              kind: "variable",
              mode: "git",
              value: input.value,
            }),
          );
        } else if (command === "remove_app_variable") entries.length = 0;
        else if (command === "recover_app_variables") {
          if (failRecovery) throw new Error("raw recovery detail");
        } else throw new Error(`Unexpected ${command}`);
        return result;
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    function Harness() {
      const editor = useVariableCatalogEditor(scope);
      useLayoutEffect(() => {
        state = editor;
      });
      return (
        <output>
          {editor.draft?.name ?? "closed"}:{String(editor.error)}
        </output>
      );
    }
    try {
      await act(async () => {
        root.render(<Harness />);
        await tick();
      });
      for (const outcome of [
        { status: "committed" } as const,
        { status: "pending", reason: "policy_off" } as const,
        { status: "pending", reason: "index_staged" } as const,
        { status: "failed", message: "sanitized" } as const,
      ]) {
        toast.dismiss();
        const previousToasts = toast.getToasts().length;
        result = {
          effects: [{ ownerPath: "/repo", config: outcome, rootPointer: null }],
        };
        await act(async () => state.begin());
        await act(async () =>
          state.updateDraft({
            ...state.draft!,
            name: "SAVED",
            value: "public",
            storage: "git",
          }),
        );
        await act(async () => {
          await state.save();
        });
        expect(state.draft).toBe(null);
        expect(state.error).toBe(false);
        expect(state.pending).toBe(false);
        expect(dom.window.document.body.textContent).toBe("closed:false");
        const feedback = toast.getToasts().slice(previousToasts);
        expect(
          feedback.some(
            (item) =>
              "title" in item &&
              item.title === m.app_variables_git_commit_failed(),
          ),
        ).toBe(outcome.status === "failed");
        await act(async () => state.requestRemove(state.catalog!.entries[0]!));
        await act(async () => {
          await state.remove();
        });
        expect(state.removing).toBe(null);
        expect(state.catalog!.entries).toEqual([]);
      }
      expect(
        calls.filter((call) => call === "upsert_app_variable").length,
      ).toBe(4);
      failWrite = true;
      await act(async () => state.begin());
      await act(async () =>
        state.updateDraft({
          ...state.draft!,
          name: "RETAINED",
          value: "draft",
        }),
      );
      await act(async () => {
        await state.save();
      });
      expect(state.error).toBe(true);
      expect(state.draft?.value).toBe("draft");
      await act(async () => state.cancel());
      result = {
        completed: true,
        effects: [
          {
            ownerPath: "/repo",
            config: { status: "committed" },
            rootPointer: { status: "failed", message: "sanitized" },
          },
        ],
      };
      const count = calls.length;
      await act(async () => {
        await state.recover({ scope: "project" });
      });
      expect(state.error).toBe(false);
      expect(state.pending).toBe(false);
      expect(state.attempt).toBe(null);
      expect(calls.slice(count)).toEqual(["recover_app_variables"]);
      const titles = toast
        .getToasts()
        .map((item) => ("title" in item ? item.title : null));
      expect(titles.includes(m.app_variables_git_pointer_failed())).toBe(true);
      expect(titles.includes(m.variables_recovery_done())).toBe(true);
      failRecovery = true;
      await act(async () => {
        await state.recover({ scope: "project" });
      });
      expect(state.attempt).toEqual({
        target: "project",
        action: "recover",
        state: "failed",
      });
      expect(state.error).toBe(false);
      expect(
        dom.window.document.body.textContent?.includes("raw recovery detail"),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
      toast.dismiss();
      clearNativeMocks();
      restore();
      dom.window.close();
    }
  });
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    CustomEvent: dom.window.CustomEvent,
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
