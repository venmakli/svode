import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

import type { PageWarning } from "../model/types";

// The Space and toast mocks must not reach other test files of the process.
const isolated = process.env.SVODE_FILENAME_WARNING_DOM === "1";
if (!isolated) {
  test("filename warning DOM scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_FILENAME_WARNING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 30000);
}
const domTest: typeof test = isolated ? test : () => undefined;

interface ToastCall {
  title: string;
  options: {
    description?: string;
    action?: { label: string; onClick: () => void };
  };
}

const toasts: ToastCall[] = [];
const spaceState = {
  activeRootName: "Bigquest",
  activeRootPath: "/work/bigquest",
  spaces: [
    { name: "Compliance", path: "/work/bigquest/compliance" },
    { name: "Design", path: "/work/bigquest/design" },
  ],
};

// Radix reads the DOM globals when its modules load, before any render.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
if (isolated) {
  installDomGlobals(dom);
  const realSonner = await import("sonner");
  mock.module("sonner", () => ({
    ...realSonner,
    toast: Object.assign(() => undefined, realSonner.toast, {
      warning: (title: string, options: ToastCall["options"]) => {
        toasts.push({ title, options });
      },
    }),
  }));
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));
}

function blocker(repositoryPath: string) {
  return {
    repositoryId: `opaque-${repositoryPath}`,
    repositoryPath,
    status: "read_only" as const,
    reason: "none" as const,
  };
}

const accessWarning = (paths: string[]): PageWarning => ({
  kind: "filename_rename_deferred",
  message: "technical: opaque read_only none",
  path: "protsessy/README.md",
  reason: "repository_access_denied",
  blockers: paths.map(blocker),
});

const schemaWarning: PageWarning = {
  kind: "filename_rename_deferred",
  message: "/Project/spaces/design/Tasks/schema.yaml: unknown variant checkbox",
  path: "legacy.md",
};

domTest(
  "a deferred rename for access shows one line and its details on request",
  async () => {
    const harness = await renderHarness();
    try {
      harness.publish([accessWarning(["/work/bigquest/compliance"])]);
      const [notice] = toasts;
      expect(notice.title).toBe("File not renamed");
      expect(notice.options.description).toBe("No write access: Compliance.");
      expect(notice.options.action?.label).toBe("Details");
      expect(harness.dialog()).toBeNull();

      await act(async () => {
        notice.options.action?.onClick();
        await settle();
      });
      const dialog = harness.dialog()!;
      expect(dialog.getAttribute("data-page-filename-warning")).toBe("access");
      const text = dialog.textContent ?? "";
      expect(text.includes("File not renamed")).toBe(true);
      expect(
        text.includes(
          "The title was saved, the file remains at protsessy/README.md.",
        ),
      ).toBe(true);
      expect(text.includes("press Enter in the Page title")).toBe(true);
      expect(text.includes("opaque")).toBe(false);
      expect(text.includes("technical")).toBe(false);
      const rows = harness.rows();
      expect(rows.length).toBe(1);
      expect(rows[0].textContent?.includes("Compliance")).toBe(true);
      expect(rows[0].textContent?.includes("Read only")).toBe(true);
      expect(rows[0].textContent?.includes("/work/bigquest/compliance")).toBe(
        false,
      );
      expect(rows[0].getAttribute("title")).toBe("/work/bigquest/compliance");
      expect(dom.window.document.activeElement?.textContent).toBe("Close");

      await act(async () => {
        buttonIn(rows[0], "Git settings").click();
        await settle();
      });
      await act(settle);
      expect(harness.opened).toEqual(["/work/bigquest/compliance"]);
      expect(harness.dialog()).toBeNull();
    } finally {
      await harness.cleanup();
    }
  },
);

domTest(
  "four refusing repositories name three in the toast and all in the details",
  async () => {
    const harness = await renderHarness();
    try {
      harness.publish([
        accessWarning([
          "/work/bigquest/compliance",
          "/work/bigquest/design",
          "/elsewhere/archive",
          "/work/bigquest",
        ]),
      ]);
      const [notice] = toasts;
      expect(notice.options.description).toBe(
        "No write access: Compliance, Design, archive and 1 more.",
      );

      await act(async () => {
        notice.options.action?.onClick();
        await settle();
      });
      const rows = harness.rows();
      expect(
        rows.map(
          (row) => row.querySelector("[data-slot=item-title]")?.textContent,
        ),
      ).toEqual(["Compliance", "Design", "/elsewhere/archive", "Bigquest"]);

      // A repository outside the project and its Spaces opens project settings.
      await act(async () => {
        buttonIn(rows[2], "Git settings").click();
        await settle();
      });
      await act(settle);
      expect(harness.opened).toEqual(["/work/bigquest"]);
    } finally {
      await harness.cleanup();
    }
  },
);

domTest(
  "a deferred rename for another cause keeps the backend text for the details",
  async () => {
    const harness = await renderHarness();
    try {
      harness.publish([schemaWarning, { ...schemaWarning, path: undefined }]);
      const [notice, pathless] = toasts;
      expect(notice.title).toBe("File not renamed");
      expect(notice.options.description).toBe(
        "Couldn't verify rename dependencies.",
      );
      expect(pathless.options.description).toBe(
        "Couldn't verify rename dependencies.",
      );

      await act(async () => {
        notice.options.action?.onClick();
        await settle();
      });
      const dialog = harness.dialog()!;
      expect(dialog.getAttribute("data-page-filename-warning")).toBe(
        "dependencies",
      );
      expect(
        dialog.querySelector("[data-page-filename-warning-message]")
          ?.textContent,
      ).toBe(schemaWarning.message);
      expect(
        dialog.textContent?.includes("the file remains at legacy.md."),
      ).toBe(true);
      expect(harness.rows().length).toBe(0);

      await act(async () => {
        buttonIn(dialog, "Close").click();
        await settle();
      });
      await act(settle);
      expect(harness.dialog()).toBeNull();

      await act(async () => {
        pathless.options.action?.onClick();
        await settle();
      });
      expect(
        harness
          .dialog()
          ?.textContent?.includes(
            "The title was saved, the file kept its name.",
          ),
      ).toBe(true);
    } finally {
      await harness.cleanup();
    }
  },
);

domTest("the warning and its details read in Russian", async () => {
  const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
  const originalLocale = getLocale();
  await setLocale("ru", { reload: false });
  const harness = await renderHarness();
  try {
    harness.publish([
      accessWarning([
        "/work/bigquest/compliance",
        "/work/bigquest/design",
        "/elsewhere/archive",
        "/work/bigquest",
      ]),
      schemaWarning,
    ]);
    const [access, schema] = toasts;
    expect(access.title).toBe("Файл не переименован");
    expect(access.options.description).toBe(
      "Нет доступа на запись: Compliance, Design, archive и ещё 1.",
    );
    expect(access.options.action?.label).toBe("Подробнее");
    expect(schema.options.description).toBe(
      "Не удалось проверить зависимости переименования.",
    );

    await act(async () => {
      access.options.action?.onClick();
      await settle();
    });
    const text = harness.dialog()?.textContent ?? "";
    expect(
      text.includes(
        "Название сохранено, файл остался по пути protsessy/README.md.",
      ),
    ).toBe(true);
    expect(
      text.includes(
        "Когда причина будет устранена, нажмите Enter в названии страницы.",
      ),
    ).toBe(true);
    expect(harness.rows()[0].textContent?.includes("Только чтение")).toBe(true);
    expect(buttonIn(harness.rows()[0], "Настройки Git").disabled).toBe(false);
  } finally {
    await harness.cleanup();
    await setLocale(originalLocale, { reload: false });
  }
});

domTest(
  "projection and collision stay short notices with the path",
  async () => {
    const harness = await renderHarness();
    try {
      harness.publish([
        { kind: "filename_projection", message: "m", path: "Plan-Q3.md" },
        {
          kind: "filename_collision_allocated",
          message: "m",
          path: "Plan-1.md",
        },
        { kind: "filename_rename_collision", message: "m", path: "legacy.md" },
        { kind: "malformed_frontmatter", message: "broken" },
      ]);
      expect(
        toasts.map(({ title, options }) => [
          title,
          options.description,
          options.action,
        ]),
      ).toEqual([
        ["Filename adjusted", "Saved safely as Plan-Q3.md.", undefined],
        [
          "Filename already in use",
          "The preferred filename was occupied; the file was saved as Plan-1.md.",
          undefined,
        ],
        [
          "Filename already in use",
          "The title was saved, but the file remains at legacy.md.",
          undefined,
        ],
      ]);
    } finally {
      await harness.cleanup();
    }
  },
);

async function renderHarness() {
  const { createRoot } = await import("react-dom/client");
  const [{ PageFilenameWarningDialog }, { publishPageFilenameWarnings }] =
    await Promise.all([
      import("./page-filename-warning-dialog"),
      import("../lib/filename-warning"),
    ]);
  const { registerRepositorySettingsOpener } =
    await import("@/features/git/app-shell");
  const opened: string[] = [];
  const unregister = registerRepositorySettingsOpener((path) =>
    opened.push(path),
  );
  toasts.length = 0;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PageFilenameWarningDialog />);
    await settle();
  });
  const document = dom.window.document;
  return {
    opened,
    publish: publishPageFilenameWarnings,
    dialog: () =>
      document.querySelector<HTMLElement>("[data-page-filename-warning]"),
    rows: () => [
      ...document.querySelectorAll<HTMLElement>(
        "[data-repository-access-denial-items] [data-repository-access-blocker-item]",
      ),
    ],
    cleanup: async () => {
      const { usePageFilenameWarningDetails } =
        await import("../model/filename-warning-details");
      await act(async () => {
        usePageFilenameWarningDetails.setState({ details: null, open: false });
        await settle();
      });
      unregister();
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonIn(container: Element, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`No ${label} button`);
  return button;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await nextTurn();
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
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
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
