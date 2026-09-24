import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SpaceInfo } from "@/features/space";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { variableFixture, catalogFixture } from "../model/testing/variables";
import type { AppVariableEntry } from "../model/app-variables";
import {
  GlobalVariablesSection,
  ProjectVariablesSection,
} from "./app-variables-section";

test("global catalog edits a Secret without reading or replacing its value", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const mutations: Array<{ command: string; args: unknown }> = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "get_app_variables") {
        return catalogFixture(
          [
            variableFixture(
              {
                name: "SHARED_SECRET",
                kind: "secret",
                hasValue: true,
                usedIn: [
                  { ownerDirectory: "/repo/admin", referenceName: "OTHER" },
                  {
                    ownerDirectory: "/repo/space",
                    referenceName: "S3 Secret Key",
                  },
                ],
              },
              { scope: "global" },
            ),
          ],
          { scope: "global" },
        );
      }
      if (
        command === "upsert_app_variable" ||
        command === "set_app_variable_binding"
      ) {
        mutations.push({ command, args });
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<GlobalVariablesSection />);
      await nextTurn();
      await nextTurn();
    });
    expect(dom.window.document.body.textContent?.includes("••••••••")).toBe(
      true,
    );
    expect(dom.window.document.body.textContent?.includes("top-secret")).toBe(
      false,
    );
    expect(
      dom.window.document.body.textContent?.includes("admin · OTHER"),
    ).toBe(true);

    expect(
      dom.window.document.body.textContent?.includes(
        "/repo/space · S3 Secret Key",
      ),
    ).toBe(true);

    const createButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) => button.getAttribute("aria-label") === "Edit SHARED_SECRET",
    );
    await act(async () => {
      createButton?.click();
      await nextTurn();
    });
    const saveButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    await act(async () => {
      saveButton?.click();
      await nextTurn();
      await nextTurn();
      await nextTurn();
    });

    expect(mutations.map((mutation) => mutation.command)).toEqual([
      "upsert_app_variable",
    ]);
    expect(mutations[0]?.args).toEqual({
      input: {
        source: { owner: { scope: "global" }, name: "SHARED_SECRET" },
        mode: "local",
        kind: "secret",

        revision: "r1",
        operation: "edit",
      },
    });
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("project page gives every owner a block with one editor on the page", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const document = dom.window.document;
  const projectEntries: AppVariableEntry[] = [
    variableFixture({
      name: "API_URL",
      kind: "variable",
      mode: "git",
      value: "https://example.test",
      usedIn: [{ ownerDirectory: "/repo/apps/site", referenceName: "API" }],
    }),
    variableFixture({ name: "TOKEN", kind: "secret" }),
  ];
  let projectRevision = "r1";
  const writes: unknown[] = [];
  let finishWrite: (() => void) | null = null;
  mockNativeIpc(
    async (command, args) => {
      if (command === "get_app_variables") {
        const spaceId = (args as { scope?: { spaceId: string | null } }).scope
          ?.spaceId;
        if (!spaceId) {
          const catalog = catalogFixture(structuredClone(projectEntries));
          catalog.owners[0]!.revision = projectRevision;
          return catalog;
        }
        const owner = { scope: "space", id: spaceId } as const;
        const catalog = catalogFixture(
          [
            ...(spaceId === "docs"
              ? [
                  variableFixture(
                    { name: "DOCS_ONLY", kind: "variable", value: "docs" },
                    owner,
                  ),
                ]
              : []),
            ...projectEntries.map((entry) => ({ ...entry, inherited: true })),
          ],
          owner,
        );
        catalog.owners.push({
          owner: { scope: "project" },
          label: "/repo",
          revision: "r1",
          error: null,
        });
        return catalog;
      }
      if (command === "upsert_app_variable") {
        writes.push(args);
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
        projectEntries.push(
          variableFixture({
            name: "NEW_VAR",
            kind: "variable",
            value: "v",
            revision: projectRevision,
          }),
        );
        return { effects: [], recoveryError: null };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const guards = new Set<() => boolean>();
  const register = (guard: () => boolean) => {
    guards.add(guard);
    return () => {
      guards.delete(guard);
    };
  };
  const space = (id: string, name: string) =>
    ({
      id,
      name,
      icon: "",
      description: "",
      path: `/repo/${id}`,
      hasSpaces: false,
      hasSchema: false,
      lastOpened: null,
      status: "ready",
      lfsState: "not_applicable",
    }) as unknown as SpaceInfo;
  const root = createRoot(document.getElementById("app")!);
  const block = (name: string) =>
    Array.from(document.querySelectorAll("section")).find(
      (section) =>
        section.querySelector(":scope > h3 span[id]")?.textContent === name,
    )!;
  const button = (scope: ParentNode, label: string) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) =>
        item.getAttribute("aria-label") === label || item.textContent === label,
    )!;
  const press = async (target: HTMLElement) =>
    act(async () => {
      target.click();
      await nextTurn();
      await nextTurn();
    });

  try {
    await act(async () => {
      root.render(
        <ProjectVariablesSection
          projectPath="/repo"
          projectName="Testov"
          projectIcon=""
          spaces={[space("docs", "Сопровождение"), space("dev", "Разработки")]}
          gitTypes={{ docs: "inline", dev: "independent" }}
          registerLeaveGuard={register}
        />,
      );
      await nextTurn();
      await nextTurn();
    });
    const owners = Array.from(document.querySelectorAll("section > h3"));
    expect(
      owners.map((heading) => heading.querySelector("span[id]")?.textContent),
    ).toEqual(["Testov", "Сопровождение", "Разработки"]);
    expect(owners.map((heading) => heading.textContent)).toEqual([
      "\u{1F4C1}TestovProject",
      "\u{1F4C1}СопровождениеIn project",
      "\u{1F4C1}РазработкиSeparate repository",
    ]);
    const project = block("Testov");
    const docs = block("Сопровождение");
    const dev = block("Разработки");
    for (const owner of [project, docs, dev]) {
      expect(owner.querySelector("h4")?.textContent).toBe("Variables");
      expect(owner.querySelectorAll('[data-slot="card"]').length).toBe(1);
      expect(button(owner, "Add variable").disabled).toBe(false);
    }
    expect(
      project
        .querySelector('[data-variable="API_URL"]')
        ?.textContent?.includes("Known usage: apps/site · API"),
    ).toBe(true);
    expect(docs.querySelector('[data-variable="DOCS_ONLY"]') !== null).toBe(
      true,
    );
    const inherited = docs.querySelector<HTMLElement>(
      '[data-variable="API_URL"][data-inherited]',
    )!;
    expect(inherited.textContent?.includes("Inherited from the project")).toBe(
      true,
    );
    expect(button(inherited, "Edit API_URL") === undefined).toBe(true);

    await press(button(docs, "Edit API_URL in the project"));
    const projectEditor = project.querySelector<HTMLFormElement>(
      'form[aria-label="Edit variable"]',
    )!;
    expect(projectEditor !== null).toBe(true);
    expect(document.activeElement?.id.endsWith("-value")).toBe(true);
    expect(
      projectEditor
        .querySelector('[role="tablist"]')
        ?.getAttribute("aria-label"),
    ).toBe("Storage");
    expect(button(docs, "Add variable").disabled).toBe(true);
    expect(button(dev, "Override API_URL in this space").disabled).toBe(true);
    expect(button(project, "Edit TOKEN").disabled).toBe(true);
    expect(document.querySelectorAll("form").length).toBe(1);
    const valueInput = document.activeElement!;
    expect(valueInput.getAttribute("autocorrect")).toBe("off");
    expect(valueInput.getAttribute("autocapitalize")).toBe("off");
    expect(valueInput.getAttribute("spellcheck")).toBe("false");

    await act(async () => {
      button(projectEditor, "Local").dispatchEvent(
        new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });
    const storageRow = projectEditor
      .querySelector('[role="tablist"]')!
      .closest('[data-slot="field"]')!;
    expect(
      storageRow.textContent?.includes("Saving removes the Git declaration."),
    ).toBe(true);
    expect(
      storageRow.textContent?.includes(
        "Previously committed values can remain in Git history.",
      ),
    ).toBe(true);

    projectRevision = "r2";
    projectEntries[0] = {
      ...projectEntries[0]!,
      value: "https://changed.test",
      revision: projectRevision,
    };
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await nextTurn();
      await nextTurn();
    });
    expect(
      projectEditor.textContent?.includes(
        "This variable changed outside this form.",
      ),
    ).toBe(true);
    await press(button(projectEditor, "Review latest and keep draft"));
    expect(
      projectEditor.textContent?.includes(
        "Currently saved: https://changed.test",
      ),
    ).toBe(true);
    expect(
      projectEditor.textContent?.includes("The source was reloaded."),
    ).toBe(true);
    expect(
      projectEditor.querySelector<HTMLInputElement>('input[id$="-value"]')
        ?.value,
    ).toBe("https://example.test");

    await press(button(projectEditor, "Cancel"));
    expect(document.querySelector("form")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Edit API_URL",
    );
    expect(button(docs, "Add variable").disabled).toBe(false);

    await press(button(docs, "Override API_URL in this space"));
    const override = docs.querySelector<HTMLFormElement>(
      'form[aria-label="Add variable"]',
    )!;
    const overrideName =
      override.querySelector<HTMLInputElement>('input[id$="-name"]')!;
    expect(overrideName.value).toBe("API_URL");
    expect(overrideName.disabled).toBe(false);
    expect(document.activeElement).toBe(overrideName);
    expect(button(project, "Add variable").disabled).toBe(true);
    await press(button(override, "Cancel"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Override API_URL in this space",
    );

    await press(button(project, "Add variable"));
    const create = project.querySelector<HTMLFormElement>(
      'form[aria-label="Add variable"]',
    )!;
    expect(create.parentElement?.getAttribute("data-slot")).toBe("card");
    expect(create.parentElement?.firstElementChild).toBe(create);
    await act(async () =>
      setInputValue(
        create.querySelector<HTMLInputElement>('input[id$="-name"]')!,
        "api_url",
      ),
    );
    expect(create.querySelector('[data-slot="field-error"]')?.textContent).toBe(
      "A variable with this name already exists here. Edit it or choose another name.",
    );
    await act(async () =>
      setInputValue(
        create.querySelector<HTMLInputElement>('input[id$="-name"]')!,
        "new_var",
      ),
    );
    await act(async () =>
      setInputValue(
        create.querySelector<HTMLInputElement>('input[id$="-value"]')!,
        "v",
      ),
    );
    await press(button(create, "Save"));
    expect([...guards].every((guard) => guard())).toBe(false);
    expect(writes).toEqual([
      {
        input: {
          source: { owner: { scope: "project" }, name: "NEW_VAR" },
          mode: "local",
          kind: "variable",
          operation: "create",
          revision: "r2",
          value: "v",
          scope: { projectPath: "/repo", spaceId: null },
        },
      },
    ]);
    await act(async () => {
      finishWrite?.();
      await nextTurn();
      await nextTurn();
      await nextTurn();
    });
    expect(document.querySelector("form")).toBeNull();
    expect([...guards].every((guard) => guard())).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Edit NEW_VAR",
    );
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const window = input.ownerDocument.defaultView!;
  // React watches value changes of the focused text input in this DOM.
  input.focus();
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const propertyChange = new window.Event("propertychange", { bubbles: true });
  Object.defineProperty(propertyChange, "propertyName", { value: "value" });
  input.dispatchEvent(propertyChange);
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
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
