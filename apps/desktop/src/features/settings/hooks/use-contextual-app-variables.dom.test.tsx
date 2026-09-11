import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useLayoutEffect, useState } from "react";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { emit } from "@/platform/native/events";
import type {
  AppVariableEntry,
  AppVariablesCatalog,
  AppVariablesContext,
} from "../model";
import { variableFixture, catalogFixture } from "../model/testing/variables";
import type { VariableSource } from "../model/app-variables";
import type { useContextualAppVariables } from "./use-contextual-app-variables";

if (process.env.SVODE_CONTEXTUAL_VARIABLES_TEST !== "1") {
  (test as (name: string, run: () => void, timeout: number) => void)(
    "contextual Variables DOM and async lifecycle",
    () => {
      const child = spawnSync(
        process.execPath,
        ["test", "--timeout", "30000", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, SVODE_CONTEXTUAL_VARIABLES_TEST: "1" },
          encoding: "utf8",
        },
      );
      if (child.status !== 0) throw new Error(child.stdout + child.stderr);
      expect(child.status).toBe(0);
    },
    120000,
  );
} else {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const { beforeAll, afterAll } = bunTest as typeof bunTest & {
    beforeAll(run: () => void): void;
    afterAll(run: () => void): void;
  };
  let restore: () => void;
  beforeAll(() => {
    restore = installDomGlobals(dom);
  });
  afterAll(() => {
    restore();
    dom.window.close();
  });
  const context: AppVariablesContext = {
    projectPath: "/repo",
    spaceId: null,
    ownerPath: "demo",
  };
  type Controller = ReturnType<typeof useContextualAppVariables>;

  async function setup() {
    const { createRoot } = await import("react-dom/client");
    const { useContextualAppVariables } =
      await import("./use-contextual-app-variables");
    const entries: AppVariableEntry[] = [
      {
        name: "SHARED",
        kind: "secret",
        hasValue: true,
        usedIn: [
          { ownerDirectory: "/repo/demo", referenceName: "TOKEN" },
          { ownerDirectory: "/repo/demo", referenceName: "ALIAS" },
        ],
      },
      { name: "EMPTY_SECRET", kind: "secret", hasValue: false, usedIn: [] },
      {
        name: "OTHER_APP",
        kind: "variable",
        value: "unrelated",
        hasValue: true,
        usedIn: [],
      },
    ].map((e) =>
      variableFixture({ ...e, kind: e.kind as "secret" | "variable" }),
    );
    const bindings: Record<string, string> = {
      TOKEN: "SHARED",
      ALIAS: "SHARED",
    };
    const fixture = {
      references: ["TOKEN", "URL", "ALIAS", "EMPTY_SECRET"],
      entries,
      bindings,
      failLoad: false,
      failSave: false,
      failBind: false,
      beforeGet: undefined as (() => Promise<unknown>) | undefined,
      beforeSave: undefined as (() => Promise<unknown>) | undefined,
      calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
    };
    function catalog(): AppVariablesCatalog {
      return {
        ...catalogFixture(structuredClone(entries)),
        context: fixture.references.map((referenceName) => {
          const entryName = bindings[referenceName] ?? referenceName;
          const entry = entries.find((item) => item.name === entryName);
          return {
            referenceName,
            entryName,
            source: entry?.source ?? {
              owner: { scope: "project" },
              name: entryName,
            },
            explicit: Boolean(bindings[referenceName]),
            resolved: entry?.hasValue ?? false,
            kind: entry?.kind,
          };
        }),
      };
    }
    mockNativeIpc(
      async (command, args) => {
        if (command === "get_app_variables") {
          const snapshot = catalog();
          await fixture.beforeGet?.();
          if (fixture.failLoad) throw new Error("load failed");
          return snapshot;
        }
        const input = (args as { input: Record<string, unknown> }).input;
        fixture.calls.push({ command, args: input });
        if (command === "upsert_app_variable") {
          await fixture.beforeSave?.();
          if (fixture.failSave) throw new Error("Keychain failed");
          const source = input.source as VariableSource;
          const entry = entries.find((item) => item.name === source.name);
          const next: AppVariableEntry = variableFixture({
            source,
            name: source.name,
            kind: input.kind as "secret" | "variable",
            mode: input.mode as "local" | "git",
            hasValue:
              input.kind === "variable" ||
              Boolean(input.value) ||
              Boolean(entry?.hasValue),
            usedIn: entry?.usedIn ?? [],
            ...(input.kind === "variable"
              ? { value: String(input.value) }
              : {}),
          });
          if (entry) Object.assign(entry, next);
          else entries.push(next);
          return null;
        }
        if (command === "set_app_variable_binding") {
          if (fixture.failBind) throw new Error("binding failed");
          if (input.source)
            bindings[String(input.referenceName)] = (
              input.source as VariableSource
            ).name;
          else delete bindings[String(input.referenceName)];
          return null;
        }
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    let state!: Controller;
    function Harness({ owner }: { owner: AppVariablesContext }) {
      const controller = useContextualAppVariables(owner);
      useLayoutEffect(() => {
        state = controller;
      });
      return (
        <output>
          {controller.references.map((item) => item.referenceName).join(",")}
        </output>
      );
    }
    const root = createRoot(dom.window.document.getElementById("app")!);
    await act(async () => {
      root.render(<Harness key="demo" owner={context} />);
      await tick();
    });
    return {
      fixture,
      root,
      get state() {
        return state;
      },
      async begin(name: string, mode: "value" | "binding" = "value") {
        await act(async () =>
          state.begin(
            state.references.find((item) => item.referenceName === name)!,
            mode,
          ),
        );
      },
      async changeOwner() {
        await act(async () => {
          root.render(
            <Harness key="other" owner={{ ...context, ownerPath: "other" }} />,
          );
          await tick();
        });
      },
      async cleanup() {
        await act(async () => root.unmount());
        clearNativeMocks();
      },
    };
  }

  test("complete references, Secret preservation and two references sharing a source", async () => {
    const h = await setup();
    try {
      expect(h.state.references.map((item) => item.referenceName)).toEqual([
        "EMPTY_SECRET",
        "URL",
        "ALIAS",
        "TOKEN",
      ]);
      expect(
        h.state.references.some((item) => item.referenceName === "OTHER_APP"),
      ).toBe(false);
      await h.begin("TOKEN");
      expect(h.state.editor?.draft.value).toBe("");
      expect(h.state.entry?.usedIn.length).toBe(2);
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls).toEqual([
        {
          command: "upsert_app_variable",
          args: {
            source: { owner: { scope: "project" }, name: "SHARED" },
            mode: "local",
            kind: "secret",
            identity: "id-SHARED",
            revision: "r1",
            scope: context,
          },
        },
      ]);
      await h.begin("EMPTY_SECRET");
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls.length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("create then bind retries only the binding after partial success", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      await act(async () =>
        h.state.updateDraft({
          ...h.state.editor!.draft,
          name: "LOCAL_URL",
          value: "https://example.test",
        }),
      );
      h.fixture.failBind = true;
      await act(async () => {
        await h.state.submit();
      });
      expect(h.state.error).toBe("partial");
      expect(h.state.editor?.savedEntry).toEqual({
        owner: { scope: "project" },
        name: "LOCAL_URL",
      });
      h.fixture.failBind = false;
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls.map((item) => item.command)).toEqual([
        "upsert_app_variable",
        "set_app_variable_binding",
        "set_app_variable_binding",
      ]);
      expect(
        h.state.references.find((item) => item.referenceName === "URL")
          ?.entryName,
      ).toBe("LOCAL_URL");
    } finally {
      await h.cleanup();
    }
  });

  test("collision requires an explicit binding; changing a configured source never edits it", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      await act(async () =>
        h.state.updateDraft({ ...h.state.editor!.draft, name: "SHARED" }),
      );
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls).toEqual([]);
      expect(h.state.collision?.name).toBe("SHARED");
      await act(async () => h.state.useCollision());
      await act(async () => {
        await h.state.submit();
      });
      await h.begin("TOKEN", "binding");
      await act(async () => h.state.selectEntry("project:OTHER_APP"));
      expect(h.state.stale).toBe(false);
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls.map((item) => item.command)).toEqual([
        "set_app_variable_binding",
        "set_app_variable_binding",
      ]);
      expect(h.fixture.bindings.TOKEN).toBe("OTHER_APP");
      expect(h.fixture.bindings.ALIAS).toBe("SHARED");
    } finally {
      await h.cleanup();
    }
  });

  test("save errors and invalidation preserve input; cancel does not write", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      await act(async () =>
        h.state.updateDraft({ ...h.state.editor!.draft, value: "draft" }),
      );
      h.fixture.failSave = true;
      await act(async () => {
        await h.state.submit();
      });
      expect(h.state.error).toBe("save");
      await act(async () => {
        await emit("app-settings:variables-changed");
        await tick();
      });
      expect(h.state.editor?.draft.value).toBe("draft");
      await act(async () => h.state.cancel());
      expect(h.state.editor).toBeNull();
      expect(h.fixture.calls.length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("fresh owner/reference validation and collision prevent stale writes", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      h.fixture.references = h.fixture.references.filter(
        (item) => item !== "URL",
      );
      await act(async () => {
        await h.state.submit();
      });
      expect(h.state.error).toBe("stale");
      expect(h.fixture.calls).toEqual([]);
      h.fixture.references.push("URL");
      await act(async () => {
        await h.state.refresh();
      });
      await h.begin("URL");
      h.fixture.entries.push(
        variableFixture({
          name: "URL",
          kind: "variable",
          value: "external",
          hasValue: true,
          usedIn: [],
        }),
      );
      await act(async () => {
        await h.state.submit();
      });
      expect(h.state.error).toBe("collision");
      expect(h.fixture.calls).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("pending suppresses duplicate submissions; owner change stops late create/bind continuation", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      const deferred = deferredVoid();
      h.fixture.beforeSave = () => deferred.promise;
      let operation!: Promise<unknown>;
      await act(async () => {
        operation = h.state.submit();
        await tick();
      });
      expect(h.state.pending).toBe(true);
      await act(async () => {
        void h.state.submit();
        h.state.cancel();
      });
      expect(h.state.editor !== null).toBe(true);
      await h.changeOwner();
      expect(h.state.editor).toBeNull();
      await act(async () => {
        deferred.resolve();
        await operation;
      });
      expect(h.fixture.calls.map((item) => item.command)).toEqual([
        "upsert_app_variable",
      ]);
      expect(h.state.saved).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("load errors retry and stale load responses cannot replace a new owner", async () => {
    const h = await setup();
    try {
      h.fixture.failLoad = true;
      await act(async () => {
        await h.state.refresh().catch(() => undefined);
      });
      expect(h.state.loadError).toBe(true);
      h.fixture.failLoad = false;
      await act(async () => {
        await h.state.refresh();
      });
      expect(h.state.loadError).toBe(false);
      const deferred = deferredVoid();
      h.fixture.beforeGet = () => deferred.promise;
      let refresh!: Promise<unknown>;
      await act(async () => {
        refresh = h.state.refresh();
      });
      h.fixture.beforeGet = undefined;
      h.fixture.references = [];
      await h.changeOwner();
      await act(async () => {
        deferred.resolve();
        await refresh;
      });
      expect(h.state.references).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("Git Secret declaration saves without a value and remains missing; stale draft requires explicit review", async () => {
    const h = await setup();
    try {
      await h.begin("URL");
      await act(async () =>
        h.state.updateDraft({
          ...h.state.editor!.draft,
          kind: "secret",
          storage: "git",
          value: "",
        }),
      );
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls[0]?.args.source).toEqual({
        owner: { scope: "project" },
        name: "URL",
      });
      expect(h.fixture.calls[0]?.args.kind).toBe("secret");
      expect(h.fixture.calls[0]?.args.mode).toBe("git");
      expect(h.fixture.calls[0]?.args.value).toBe(undefined);
      expect(
        h.state.references.find((r) => r.referenceName === "URL")?.resolved,
      ).toBe(false);
      await h.begin("TOKEN");
      await act(async () =>
        h.state.updateDraft({
          ...h.state.editor!.draft,
          value: "draft-secret",
        }),
      );
      h.fixture.entries.find((e) => e.name === "SHARED")!.revision = "r2";
      await act(async () => {
        await h.state.refresh();
      });
      expect(h.state.stale).toBe(true);
      expect(h.state.editor?.draft.value).toBe("draft-secret");
      const writes = h.fixture.calls.length;
      await act(async () => {
        await h.state.submit();
      });
      expect(h.fixture.calls.length).toBe(writes);
    } finally {
      await h.cleanup();
    }
  });

  test("storage and Secret controls require explicit declassification and allow unset Git declarations", async () => {
    const { createRoot } = await import("react-dom/client");
    const { AppVariableFields } = await import("../ui/app-variable-fields");
    const {
      createVariableDraft,
      editVariableDraft,
      canSaveVariableDraft,
      variableDraftInput,
    } = await import("../model/app-variable-draft");
    const root = createRoot(dom.window.document.getElementById("app")!);
    const catalog = catalogFixture([]);
    let draft = createVariableDraft("KEY", catalog);
    function Harness({ initial }: { initial: typeof draft }) {
      const [value, setValue] = useState(initial);
      useLayoutEffect(() => {
        draft = value;
      });
      return (
        <AppVariableFields draft={value} disabled={false} onChange={setValue} />
      );
    }
    const click = async (text: string) =>
      act(async () => {
        const button = Array.from(
          dom.window.document.querySelectorAll("button"),
        ).find((b) => b.textContent === text)!;
        if (button.getAttribute("role") === "tab") {
          button.dispatchEvent(
            new dom.window.MouseEvent("mousedown", {
              bubbles: true,
              button: 0,
            }),
          );
        } else button.click();
      });
    const secret = async () =>
      act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>('[role="switch"]')!
          .click();
      });
    try {
      await act(async () => root.render(<Harness initial={draft} />));
      expect(canSaveVariableDraft(draft)).toBe(true);
      await secret();
      expect(draft.storage).toBe("local");
      expect(canSaveVariableDraft(draft)).toBe(false);
      await click("Git");
      expect(draft.kind).toBe("secret");
      expect(canSaveVariableDraft(draft)).toBe(true);
      expect(variableDraftInput(draft).value).toBe(undefined);
      await secret();
      expect(draft.storage).toBe("git");
      expect(draft.name).toBe("KEY");
      expect(
        dom.window.document.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
      ).toBe("Git");
      expect(canSaveVariableDraft(draft)).toBe(true);
      expect(variableDraftInput(draft).value).toBe("");
      await act(async () =>
        root.render(
          <Harness
            key="configured"
            initial={editVariableDraft(
              variableFixture({ name: "KEY", kind: "secret", mode: "git" }),
            )}
          />,
        ),
      );
      const nameInput =
        dom.window.document.querySelector<HTMLInputElement>(
          'input[id$="-name"]',
        )!;
      expect(nameInput.value).toBe("KEY");
      expect(nameInput.disabled).toBe(true);
      expect(draft.value).toBe("");
      expect(variableDraftInput(draft).value).toBe(undefined);
      await secret();
      expect(draft.value).toBe("");
      expect(canSaveVariableDraft(draft)).toBe(false);
      await click("Use an empty string");
      expect(canSaveVariableDraft(draft)).toBe(true);
      expect(variableDraftInput(draft).value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("catalog edits the inherited owner, creates an own override, and preserves draft across revision review", async () => {
    const { createRoot } = await import("react-dom/client");
    const { useVariableCatalogEditor } =
      await import("./use-variable-catalog-editor");
    const scope = { projectPath: "/repo", spaceId: "child" };
    const entry = variableFixture({
      name: "KEY",
      kind: "variable",
      value: "project",
      inherited: true,
    });
    let catalog = catalogFixture([entry], { scope: "space", id: "child" });
    catalog.owners.push({
      owner: { scope: "project" },
      label: "Project",
      revision: "r1",
      error: null,
    });
    let guard!: () => boolean | Promise<boolean>;
    const register = (next: typeof guard) => {
      guard = next;
      return () => {};
    };
    const deferred = deferredVoid();
    const writes: unknown[] = [];
    mockNativeIpc(
      async (command, args) => {
        if (command === "get_app_variables") return structuredClone(catalog);
        if (command === "upsert_app_variable") {
          writes.push(args);
          await deferred.promise;
          return null;
        }
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const root = createRoot(dom.window.document.getElementById("app")!);
    let state!: ReturnType<typeof useVariableCatalogEditor>;
    function Harness() {
      const controller = useVariableCatalogEditor(scope, register);
      useLayoutEffect(() => {
        state = controller;
      });
      return null;
    }
    try {
      await act(async () => {
        root.render(<Harness />);
        await tick();
      });
      await act(async () => state.begin(entry));
      expect(state.draft?.owner).toEqual({ scope: "project" });
      await act(async () =>
        state.updateDraft({ ...state.draft!, value: "draft" }),
      );
      catalog = {
        ...catalog,
        entries: [{ ...entry, revision: "r2", value: "external" }],
        owners: catalog.owners.map((o) =>
          o.owner.scope === "project" ? { ...o, revision: "r2" } : o,
        ),
      };
      await act(async () => {
        await state.refresh();
      });
      expect(state.stale).toBe(true);
      expect(state.draft?.value).toBe("draft");
      await act(async () => {
        await state.reviewLatest();
      });
      expect(state.stale).toBe(false);
      expect(state.draft?.value).toBe("draft");
      expect(state.draft?.revision).toBe("r2");
      await act(async () => state.begin(entry, true));
      expect(state.draft?.owner).toEqual({ scope: "space", id: "child" });
      expect(state.draft?.identity).toBe(undefined);
      expect(state.draft?.value).toBe("");
      let save!: Promise<void>;
      await act(async () => {
        save = state.save();
        await tick();
      });
      expect(await guard()).toBe(false);
      await act(async () => state.cancel());
      expect(state.draft !== null).toBe(true);
      expect(writes.length).toBe(1);
      await act(async () => {
        deferred.resolve();
        await save;
      });
      expect(await guard()).toBe(true);
      expect(state.draft).toBeNull();
    } finally {
      deferred.resolve();
      await act(async () => root.unmount());
      clearNativeMocks();
    }
  });

  test("dialog shows compact rows, storage and independent Secret control with one editor", async () => {
    const h = await setup();
    const { AppVariablesDialog } = await import("../ui/app-variables-dialog");
    try {
      await act(async () => {
        h.root.render(
          <AppVariablesDialog
            context={context}
            onClose={() => undefined}
            returnFocus={() => undefined}
          />,
        );
        await tick();
      });
      const document = dom.window.document;
      expect(
        document.querySelector('[data-slot="dialog-title"]')?.textContent,
      ).toBe("Variables");
      expect(
        document.querySelector('[data-slot="dialog-description"]')?.textContent,
      ).toBe("demo");
      expect(document.querySelector('[role="dialog"]') !== null).toBe(true);
      expect(document.body.textContent?.includes("OTHER_APP")).toBe(false);
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>('[aria-label="Edit TOKEN"]')!
          .click();
        await tick();
      });
      expect(document.querySelectorAll("form").length).toBe(1);
      expect(document.querySelectorAll('input[type="password"]').length).toBe(
        1,
      );
      expect(document.querySelectorAll('input[type="text"]').length).toBe(0);
      expect(document.body.textContent?.includes("/repo/")).toBe(false);
      expect(document.querySelectorAll('[role="switch"]').length).toBe(1);
      expect(
        document.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
      ).toBe("Storage");
      await act(async () => {
        Array.from(document.querySelectorAll("button"))
          .find((item) => item.textContent === "Cancel")!
          .click();
      });
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Edit TOKEN",
      );
      expect(h.fixture.calls).toEqual([]);
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

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
