import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
  type SystemCollectionDetailRequest,
} from "@/features/collection/system";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { ActorCatalogRow } from "../model/types";
import { ActorDetail } from "./actor-detail";
import { createActorsPresentation } from "./actors-presentation";

const actor: ActorCatalogRow = {
  aliases: [],
  availableYears: [2026, 2025],
  canonicalEmail: "ada@example.test",
  commitCount: 4,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: "2026-07-31",
  lastCommitAt: 20,
  sources: [
    {
      email: "ada@example.test",
      kind: "history",
      line: null,
      name: "Ada Lovelace",
    },
  ],
};

test("actors rows open in the real DOM and use shared row and Drawer action seams", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const requests: SystemCollectionDetailRequest[] = [];
  const presentation = createActorsPresentation({
    spacePath: "/repo",
    state: { phase: "ready", rows: [actor] },
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <SystemCollectionPresentationShell
          detailController={{
            close: async () => true,
            open: async (request) => {
              requests.push(request);
              return true;
            },
            prepareForNavigation: async () => true,
          }}
          instanceKey="actors:space:root"
          presentation={presentation}
          query={EMPTY_SYSTEM_COLLECTION_QUERY}
          onQueryChange={() => undefined}
        />,
      );
    });

    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-system-collection-row="ada@example.test"]',
    )!;
    const title = Array.from(row.querySelectorAll("span")).find(
      (element) => element.textContent === "Ada Lovelace",
    )!;

    expect(row === null).toBe(false);
    expect(row.querySelector('[aria-label="Row actions"]')).toBeNull();

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(requests.length).toBe(1);

    const drawerActions = renderToStaticMarkup(
      <>{requests[0]?.headerActions}</>,
    );
    expect(drawerActions.includes('aria-label="Row actions"')).toBe(true);

    for (const key of ["Enter", " "]) {
      await act(async () => {
        row.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, key }),
        );
      });
    }
    expect(requests.length).toBe(3);

    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 16,
          clientY: 16,
        }),
      );
      await Promise.resolve();
    });
    expect(row.getAttribute("data-state")).toBe("open");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("actor detail isolates year, exact-day, and continuation activity modes", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const calls: Array<{ args: unknown; command: string }> = [];
  mockNativeIpc((command, args) => {
    calls.push({ args: args ?? {}, command });
    if (command !== "actors_get_activity") {
      throw new Error(`Unexpected command: ${command}`);
    }
    const request = args as {
      cursor: string | null;
      selectedDay: string | null;
      selectedYear: number;
    };
    if (request.selectedYear === 2025) {
      return activityResponse({
        commitCount: 0,
        days: [],
        months: [],
        nextCursor: null,
        selectedYear: 2025,
      });
    }
    if (request.selectedDay) {
      return activityResponse({
        days: [{ commitCount: 1, date: request.selectedDay }],
        day: request.selectedDay,
        months: [activityMonth("Day-filtered commit", 4)],
        nextCursor: null,
      });
    }
    if (request.cursor === "year-next") {
      return activityResponse({
        months: [activityMonth("Older commit", 3)],
        nextCursor: null,
      });
    }
    return {
      ...activityResponse({
        days: [{ commitCount: 4, date: "2026-08-01" }],
        months: [activityMonth("Newest commit", 5)],
        nextCursor: "year-next",
      }),
    };
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    expect(calls.length).toBe(0);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorDetail actor={actor} spacePath="/repo" />
        </TooltipProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(calls).toEqual([
      {
        args: {
          canonicalEmail: "ada@example.test",
          cursor: null,
          selectedDay: null,
          selectedYear: 2026,
          spacePath: "/repo",
        },
        command: "actors_get_activity",
      },
    ]);
    expect(
      dom.window.document.querySelector(
        '[data-activity-date="2026-08-01"][data-activity-count="4"]',
      ) === null,
    ).toBe(false);
    const heatmap = dom.window.document.querySelector(
      "[data-actor-activity-heatmap]",
    ) as HTMLElement | null;
    expect(Number(heatmap?.dataset.activityWeeks) > 30).toBe(true);
    expect(dom.window.document.body.textContent?.includes("Less")).toBe(true);
    expect(dom.window.document.body.textContent?.includes("More")).toBe(true);
    expect(dom.window.document.body.textContent?.includes("Total: 5")).toBe(
      true,
    );
    expect(
      dom.window.document.body.textContent?.includes("5 commits in 2026"),
    ).toBe(false);
    expect(
      dom.window.document.body.textContent?.includes("Newest commit"),
    ).toBe(true);

    await click(dom, '[data-activity-date="2026-08-01"]');
    expect(calls[1]).toEqual({
      args: {
        canonicalEmail: "ada@example.test",
        cursor: null,
        selectedDay: "2026-08-01",
        selectedYear: 2026,
        spacePath: "/repo",
      },
      command: "actors_get_activity",
    });
    expect(
      dom.window.document.body.textContent?.includes("Day-filtered commit"),
    ).toBe(true);
    expect(
      dom.window.document
        .querySelector('[data-activity-date="2026-08-01"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    await clickButton(dom, "Show the full year");
    await clickButton(dom, "Show more");
    expect(calls[2]).toEqual({
      args: {
        canonicalEmail: "ada@example.test",
        cursor: "year-next",
        selectedDay: null,
        selectedYear: 2026,
        spacePath: "/repo",
      },
      command: "actors_get_activity",
    });
    expect(
      dom.window.document.body.textContent?.includes("Newest commit"),
    ).toBe(true);
    expect(dom.window.document.body.textContent?.includes("Older commit")).toBe(
      true,
    );

    await click(dom, 'button[aria-label="2025"]');
    expect(calls[3]?.args).toEqual({
      canonicalEmail: "ada@example.test",
      cursor: null,
      selectedDay: null,
      selectedYear: 2025,
      spacePath: "/repo",
    });
    expect(
      dom.window.document.body.textContent?.includes(
        "No commits in this period.",
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("day activity failure keeps the calendar usable and retries only the timeline", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  let dayAttempts = 0;
  mockNativeIpc((command, args) => {
    if (command !== "actors_get_activity") {
      throw new Error(`Unexpected command: ${command}`);
    }
    const request = args as { selectedDay: string | null };
    if (!request.selectedDay) {
      return activityResponse({
        days: [{ commitCount: 1, date: "2026-08-01" }],
        months: [activityMonth("Year commit", 5)],
      });
    }
    dayAttempts += 1;
    if (dayAttempts === 1) throw new Error("day projection failed");
    return activityResponse({
      day: request.selectedDay,
      days: [{ commitCount: 1, date: request.selectedDay }],
      months: [activityMonth("Recovered day commit", 4)],
    });
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorDetail actor={actor} spacePath="/repo" />
        </TooltipProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await click(dom, '[data-activity-date="2026-08-01"]');
    expect(dayAttempts).toBe(1);
    expect(
      dom.window.document.body.textContent?.includes("day projection failed"),
    ).toBe(true);
    expect(
      dom.window.document.querySelector("[data-actor-activity-heatmap]") ===
        null,
    ).toBe(false);

    await clickButton(dom, "Retry");
    expect(dayAttempts).toBe(2);
    expect(
      dom.window.document.body.textContent?.includes("Recovered day commit"),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function activityResponse({
  commitCount = 5,
  day = null,
  days = [{ commitCount: 5, date: "2026-08-01" }],
  months = [],
  nextCursor = null,
  selectedYear = 2026,
}: {
  commitCount?: number;
  day?: string | null;
  days?: Array<{ commitCount: number; date: string }>;
  months?: ReturnType<typeof activityMonth>[];
  nextCursor?: string | null;
  selectedYear?: number;
}) {
  return {
    availableYears: [2026, 2025],
    canonicalEmail: "ada@example.test",
    commitCount,
    days,
    generation: 2,
    rangeEndExclusive:
      selectedYear === 2026 ? "2026-08-03" : `${selectedYear + 1}-01-01`,
    rangeStart: `${selectedYear}-01-01`,
    repositoryId: "actor-repo-test",
    selectedYear,
    timeline: { day, months, nextCursor },
  };
}

function activityMonth(subject: string, authoredAt: number) {
  return {
    commitCount: 5,
    commits: [
      {
        authoredAt,
        localDate: "2026-08-01",
        localTime: "18:42",
        shortSha: `sha${authoredAt}`,
        subject,
      },
    ],
    month: "2026-08",
  };
}

async function click(dom: JSDOM, selector: string) {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  expect(element === null).toBe(false);
  await clickElement(dom, element!);
}

async function clickElement(dom: JSDOM, element: Element) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickButton(dom: JSDOM, label: string) {
  const button = Array.from(
    dom.window.document.querySelectorAll("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  expect(button === undefined).toBe(false);
  await clickElement(dom, button!);
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
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
