import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { SpaceInfo } from "@/features/space";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { catalogFixture, variableFixture } from "../model/testing/variables";
import type { VariablesProblem } from "../model/app-variables";

// Radix portals pick their layout effect when first imported, so the DOM must
// exist before the surfaces load: run in a child process with globals ready.
if (process.env.SVODE_VARIABLES_PROBLEM_DOM !== "1") {
  test("Variables problem DOM scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_VARIABLES_PROBLEM_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 30000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  (bunTest as typeof bunTest & { afterAll(run: () => void): void }).afterAll(
    () => {
      restoreGlobals();
      dom.window.close();
    },
  );
  const { createRoot } = await import("react-dom/client");
  const { GlobalVariablesSection, ProjectVariablesSection } =
    await import("./app-variables-section");

  const registry: VariablesProblem = {
    category: "legacy_format",
    code: "legacy_format",
    owner: { scope: "global" },
    file: "/Library/Svode/settings.json",
    section: "appVariableRegistry",
    recoverable: false,
  };
  const rejected = (problem: VariablesProblem) => ({
    kind: "variables_problem",
    message: "must-not-be-shown",
    problem,
  });

  function space(id: string, name: string) {
    return {
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
    } as unknown as SpaceInfo;
  }

  function reset() {
    dom.window.document.body.innerHTML = "<div id=app></div>";
    return dom.window.document;
  }

  async function mount(element: React.ReactElement) {
    const root = createRoot(dom.window.document.getElementById("app")!);
    await act(async () => {
      root.render(element);
      await settle();
    });
    return root;
  }

  function helpers(document: Document) {
    const block = (name: string) =>
      Array.from(document.querySelectorAll("section")).find(
        (section) =>
          section.querySelector(":scope > h3 span[id]")?.textContent === name,
      )!;
    const button = (scope: ParentNode, label: string) =>
      Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.textContent === label,
      );
    const press = async (target: HTMLElement) =>
      act(async () => {
        target.focus();
        target.click();
        await settle();
      });
    return { block, button, press };
  }

  test("a shared cause is shown once on the project page and re-reads every block", async () => {
    const document = reset();
    const reads: Array<string | null> = [];
    const commands: string[] = [];
    let broken = true;
    mockNativeIpc(
      (command, args) => {
        commands.push(command);
        if (command !== "get_app_variables")
          throw new Error(`Unexpected ${command}`);
        const spaceId =
          (args as { scope?: { spaceId: string | null } }).scope?.spaceId ??
          null;
        reads.push(spaceId);
        if (broken) throw rejected(registry);
        return catalogFixture(
          [],
          spaceId ? { scope: "space", id: spaceId } : { scope: "project" },
        );
      },
      { shouldMockEvents: true },
    );
    const { block, button, press } = helpers(document);
    const root = await mount(
      <ProjectVariablesSection
        projectPath="/repo"
        projectName="Testov"
        projectIcon=""
        spaces={[space("docs", "Сопровождение"), space("dev", "Разработки")]}
        gitTypes={{ docs: "inline", dev: "independent" }}
        reveal={{ owner: null, request: {} }}
        registerLeaveGuard={() => () => {}}
      />,
    );
    try {
      const project = block("Testov");
      const callouts = document.querySelectorAll("[data-problem]");
      expect(callouts.length).toBe(1);
      expect(project.contains(callouts[0]!)).toBe(true);
      expect(
        callouts[0]!.textContent?.includes("Svode's shared settings"),
      ).toBe(true);
      expect(document.body.textContent?.includes("must-not-be-shown")).toBe(
        false,
      );
      for (const name of ["Сопровождение", "Разработки"]) {
        const owner = block(name);
        expect(owner.querySelector("[data-problem]")).toBeNull();
        expect(
          owner.textContent?.includes(
            "Unavailable because of Svode's shared settings.",
          ),
        ).toBe(true);
        expect(owner.textContent?.includes("No variables yet")).toBe(false);
      }
      expect(button(document, "Finish saving")).toBe(undefined);
      expect(button(document, "Recover change")).toBe(undefined);

      await press(button(project, "How to fix")!);
      const details = project.querySelector("[data-problem]")!.textContent!;
      expect(details.includes("File: /Library/Svode/settings.json")).toBe(true);
      expect(details.includes("Section: appVariableRegistry")).toBe(true);
      expect(details.includes("Apps of every project")).toBe(true);
      await press(button(project, "How to fix")!);
      expect(
        project
          .querySelector("[data-problem]")!
          .textContent!.includes("File: /Library/Svode/settings.json"),
      ).toBe(false);
      expect(new Set(commands)).toEqual(new Set(["get_app_variables"]));

      await press(button(block("Разработки"), "Show the cause")!);
      expect(document.activeElement).toBe(callouts[0]!);

      const before = reads.length;
      await press(button(project, "Check again")!);
      expect(new Set(reads.slice(before))).toEqual(
        new Set([null, "docs", "dev"]),
      );
      expect(
        project
          .querySelector('[role="status"]')
          ?.textContent?.includes("The retry didn't help"),
      ).toBe(true);

      broken = false;
      await press(button(project, "Check again")!);
      expect(document.querySelectorAll("[data-problem]").length).toBe(0);
      expect(
        document.body.textContent?.includes("Unavailable because of Svode"),
      ).toBe(false);
      expect(
        Array.from(document.querySelectorAll("section")).filter((section) =>
          section.textContent?.includes("No variables yet"),
        ).length > 0,
      ).toBe(true);
      await settle();
      expect(document.activeElement?.textContent).toBe("Add variable");
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
    }
  });

  test("an unreadable project is explained in the space blocks that inherit from it", async () => {
    const document = reset();
    const reads: Array<string | null> = [];
    let problem: VariablesProblem | null = {
      category: "blocked_journal",
      code: "invalid_journal",
      owner: { scope: "project" },
      file: "/repo/.svode/variables.pending.json",
      section: null,
      recoverable: false,
    };
    mockNativeIpc(
      (command, args) => {
        if (command !== "get_app_variables")
          throw new Error(`Unexpected ${command}`);
        const spaceId =
          (args as { scope?: { spaceId: string | null } }).scope?.spaceId ??
          null;
        reads.push(spaceId);
        const project = catalogFixture(
          problem
            ? []
            : [
                variableFixture({
                  name: "ROOT",
                  kind: "variable",
                  value: "root",
                  inherited: Boolean(spaceId),
                }),
              ],
        );
        project.owners[0]!.problem = problem;
        if (problem) project.owners[0]!.revision = null;
        if (!spaceId) return project;
        const owner = { scope: "space", id: spaceId } as const;
        const own =
          spaceId === "dev"
            ? [
                variableFixture(
                  { name: "LOCAL_ONLY", kind: "variable", value: "dev" },
                  owner,
                ),
              ]
            : [];
        return {
          ...project,
          defaultOwner: owner,
          entries: [...own, ...project.entries],
          owners: [
            { owner, label: "Space", revision: "r1", problem: null },
            project.owners[0]!,
          ],
        };
      },
      { shouldMockEvents: true },
    );
    const { block, button, press } = helpers(document);
    const root = await mount(
      <ProjectVariablesSection
        projectPath="/repo"
        projectName="Testov"
        projectIcon=""
        spaces={[space("docs", "Сопровождение"), space("dev", "Разработки")]}
        gitTypes={{ docs: "inline", dev: "independent" }}
        reveal={{ owner: null, request: {} }}
        registerLeaveGuard={() => () => {}}
      />,
    );
    try {
      const project = block("Testov");
      const callouts = document.querySelectorAll("[data-problem]");
      expect(callouts.length).toBe(1);
      expect(project.contains(callouts[0]!)).toBe(true);
      expect(button(project, "Add variable")?.disabled).toBe(true);
      for (const name of ["Сопровождение", "Разработки"]) {
        const owner = block(name);
        expect(owner.querySelector("[data-problem]")).toBeNull();
        expect(
          owner.textContent?.includes(
            "Project variables are unavailable; the cause is shown above.",
          ),
        ).toBe(true);
        expect(owner.textContent?.includes("No variables yet")).toBe(false);
        expect(button(owner, "Add variable")?.disabled).toBe(false);
      }
      expect(block("Разработки").textContent?.includes("LOCAL_ONLY")).toBe(
        true,
      );

      await press(button(block("Разработки"), "Show the cause")!);
      expect(document.activeElement).toBe(callouts[0]!);

      problem = null;
      const before = reads.length;
      await press(button(project, "Check again")!);
      expect(new Set(reads.slice(before))).toEqual(
        new Set([null, "docs", "dev"]),
      );
      expect(document.querySelectorAll("[data-problem]").length).toBe(0);
      expect(
        document.body.textContent?.includes("Project variables are unavailable"),
      ).toBe(false);
      expect(block("Сопровождение").textContent?.includes("ROOT")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
    }
  });

  test("an owner's pending save is finished only for that owner and reports each result", async () => {
    const document = reset();
    let problem: VariablesProblem | null = {
      category: "pending_save",
      code: "pending_recovery",
      owner: { scope: "space", id: "dev" },
      file: "/repo/dev/.svode/variables.pending.json",
      section: null,
      recoverable: true,
    };
    const recoveries: unknown[] = [];
    let recovery: () => Promise<unknown> = async () => ({
      completed: true,
      effects: [],
    });
    mockNativeIpc(
      async (command, args) => {
        if (command === "recover_app_variables") {
          recoveries.push(args);
          return recovery();
        }
        if (command !== "get_app_variables")
          throw new Error(`Unexpected ${command}`);
        const spaceId =
          (args as { scope?: { spaceId: string | null } }).scope?.spaceId ??
          null;
        if (!spaceId)
          return catalogFixture([
            variableFixture({ name: "ROOT", kind: "variable", value: "root" }),
          ]);
        const catalog = catalogFixture([], { scope: "space", id: spaceId });
        catalog.owners[0]!.revision = null;
        if (spaceId === "dev") catalog.owners[0]!.problem = problem;
        return catalog;
      },
      { shouldMockEvents: true },
    );
    const { block, button, press } = helpers(document);
    const root = await mount(
      <ProjectVariablesSection
        projectPath="/repo"
        projectName="Testov"
        projectIcon=""
        spaces={[space("dev", "Разработки")]}
        gitTypes={{ dev: "independent" }}
        reveal={{ owner: null, request: {} }}
        registerLeaveGuard={() => () => {}}
      />,
    );
    try {
      const dev = block("Разработки");
      expect(block("Testov").querySelector("[data-problem]")).toBeNull();
      expect(dev.querySelectorAll("[data-problem]").length).toBe(1);
      expect(button(dev, "Add variable")?.disabled).toBe(true);

      let finish!: (value: unknown) => void;
      recovery = () => new Promise((resolve) => (finish = resolve));
      problem = {
        ...problem!,
        category: "blocked_journal",
        recoverable: false,
      };
      await act(async () => {
        button(dev, "Finish saving")!.click();
        button(dev, "Finish saving")?.click();
        await settle();
      });
      const pending = button(dev, "Finishing…")!;
      expect(pending.disabled).toBe(true);
      expect(recoveries).toEqual([
        {
          source: { scope: "space", id: "dev" },
          scope: { projectPath: "/repo", spaceId: "dev" },
        },
      ]);
      await act(async () => {
        finish({ completed: true, effects: [] });
        await settle();
      });
      const callout = () => dev.querySelector("[data-problem]")!;
      expect(callout().getAttribute("data-problem")).toBe("blocked_journal");
      expect(
        callout().textContent?.includes(
          "Saving finished, but the variables still can't be read.",
        ),
      ).toBe(true);
      expect(button(dev, "Finish saving")).toBe(undefined);
      expect(dev.contains(document.activeElement)).toBe(true);

      problem = { ...problem, category: "pending_save", recoverable: true };
      await press(button(dev, "Check again")!);
      recovery = async () => {
        throw new Error("raw-diagnostic");
      };
      await press(button(dev, "Finish saving")!);
      expect(callout().textContent?.includes("Couldn't finish saving.")).toBe(
        true,
      );
      expect(document.body.textContent?.includes("raw-diagnostic")).toBe(false);

      recovery = async () => ({ completed: false, effects: [] });
      await press(button(dev, "Finish saving")!);
      expect(
        callout().textContent?.includes("There is no unfinished save anymore"),
      ).toBe(true);

      recovery = async () => ({ completed: true, effects: [] });
      problem = null;
      await press(button(dev, "Finish saving")!);
      expect(dev.querySelector("[data-problem]")).toBeNull();
      expect(recoveries.length).toBe(4);
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
    }
  });

  test("the global page finishes the shared save only for the Global owner", async () => {
    const document = reset();
    const commands: Array<{ command: string; args: unknown }> = [];
    let load: () => unknown = () => {
      throw rejected({
        category: "pending_save",
        code: "pending_recovery",
        owner: { scope: "global" },
        file: "/Library/Svode/variables.pending.json",
        section: null,
        recoverable: true,
      });
    };
    mockNativeIpc(
      (command, args) => {
        commands.push({ command, args });
        if (command === "get_app_variables") return load();
        if (command === "recover_app_variables")
          return { completed: true, effects: [] };
        throw new Error(`Unexpected ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { button, press } = helpers(document);
    const root = await mount(<GlobalVariablesSection />);
    try {
      expect(document.querySelectorAll("[data-problem]").length).toBe(1);
      load = () => catalogFixture([], { scope: "global" });
      await press(button(document, "Finish saving")!);
      expect(
        commands
          .filter((item) => item.command === "recover_app_variables")
          .map((item) => item.args),
      ).toEqual([{ source: { scope: "global" } }]);
      expect(document.querySelectorAll("[data-problem]").length).toBe(0);
    } finally {
      await act(async () => root.unmount());
      clearNativeMocks();
    }
  });
}

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
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
