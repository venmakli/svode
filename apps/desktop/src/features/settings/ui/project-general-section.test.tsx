import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { setLocale } from "@/paraglide/runtime";
import { ThemeProvider } from "@/components/ui/theme-provider";
import type { SpaceInfo } from "@/features/space";
import { ProjectGeneralSection } from "./project-general-section";
import { SpaceGeneralSection } from "./space-general-section";

// The icon picker follows the app theme.
function themed(element: React.ReactElement) {
  return (
    <ThemeProvider theme="light" setTheme={() => {}}>
      {element}
    </ThemeProvider>
  );
}

function render(element: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(themed(element))).window.document;
}

function space(
  id: string,
  name: string,
  status: SpaceInfo["status"] = "ready",
): SpaceInfo {
  return {
    id,
    name,
    icon: "",
    description: "",
    path: `/repo/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status,
    lfsState: "n/a",
  } as SpaceInfo;
}

function rowLabels(group: Element) {
  return Array.from(
    group.querySelectorAll(
      '[data-slot="field-label"], [data-slot="field-title"]',
    ),
  ).map((node) => node.textContent);
}

test("general shows the project block, then every space block after the spaces heading", () => {
  setLocale("en", { reload: false });
  const document = render(
    <ProjectGeneralSection
      projectPath="/repo"
      projectName="Testov"
      projectIcon=""
      spaces={[
        space("docs", "Сопровождение"),
        space("arhiv", "arhiv", "missing"),
      ]}
      gitTypes={{ docs: "inline" }}
      reveal={{ owner: null, request: {} }}
    />,
  );
  const [project, spaces] = Array.from(
    document.querySelectorAll("body > section"),
  );
  expect(project.querySelector(":scope > h3")?.textContent).toBe(
    "\u{1F4C1}TestovProject",
  );
  const projectGroups = Array.from(
    project.querySelectorAll(":scope > section"),
  );
  expect(
    projectGroups.map((group) => group.querySelector("h4")?.textContent),
  ).toEqual(["Details", "Health"]);
  // The editable rows wait for the owner's settings; loading shows skeletons.
  expect(rowLabels(projectGroups[0])).toEqual(["Location"]);
  expect(
    projectGroups[0].querySelectorAll('[data-slot="skeleton"]').length > 0,
  ).toBe(true);
  expect(projectGroups[0].textContent?.includes("/repo")).toBe(true);
  expect(rowLabels(projectGroups[1])).toEqual(["Broken cross-space links"]);
  expect(projectGroups[1].querySelector("button")?.textContent).toBe("Refresh");

  expect(spaces.querySelector(":scope > div:first-child h3")?.textContent).toBe(
    "Spaces",
  );
  expect(
    spaces.querySelector(":scope > div:first-child button")?.textContent,
  ).toBe("Add space");
  const [docs, missing] = Array.from(
    spaces.querySelectorAll(":scope > div > section"),
  );
  expect(docs.querySelector(":scope > h3")?.textContent).toBe(
    "\u{1F4C1}СопровождениеIn project",
  );
  const docsDetails = docs.querySelector(":scope > section")!;
  expect(rowLabels(docsDetails)).toEqual(["Type", "Location"]);
  expect(
    docsDetails.textContent?.includes("Part of the project repository"),
  ).toBe(true);
  expect(docsDetails.textContent?.includes("/repo/docs")).toBe(true);
  expect(missing.querySelector(":scope > h3")?.textContent).toBe(
    "\u{1F4C1}arhivMissing",
  );
  expect(rowLabels(missing)).toEqual(["Location"]);
  expect(missing.querySelector("input, textarea, button")).toBeNull();
});

test("a project without spaces offers adding one inside the empty card", () => {
  setLocale("en", { reload: false });
  const document = render(
    <ProjectGeneralSection
      projectPath="/repo"
      projectName="Testov"
      spaces={[]}
      gitTypes={{}}
      reveal={{ owner: null, request: {} }}
    />,
  );
  const spaces = document.querySelectorAll("body > section")[1];
  expect(spaces.querySelector(":scope > div:first-child h3")?.textContent).toBe(
    "Spaces",
  );
  expect(spaces.querySelector(":scope > div:first-child button")).toBeNull();
  const empty = spaces.querySelector('[data-slot="card"] [data-slot="empty"]')!;
  expect(empty.textContent).toBe(
    "This project has no child spaces yetAdd space",
  );
});

test("a field that saves on blur stays focusable and read-only until its write ends", async () => {
  setLocale("en", { reload: false });
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true },
  );
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
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  let blurs = 0;
  let finish!: () => void;
  const editor = {
    status: "ready" as const,
    onRetry: () => {},
    icon: "",
    name: "Docs",
    description: "",
    onIconChange: async () => {},
    onNameChange: () => {},
    onNameBlur: () => {
      blurs++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    onDescriptionChange: () => {},
    onDescriptionBlur: async () => {},
  };
  const root = createRoot(dom.window.document.getElementById("app")!);
  const blur = (input: HTMLElement) =>
    act(async () => {
      input.focus();
      input.blur();
    });
  try {
    await act(async () =>
      root.render(
        themed(<SpaceGeneralSection path="/repo/docs" editor={editor} />),
      ),
    );
    const label = Array.from(
      dom.window.document.querySelectorAll("label"),
    ).find((node) => node.textContent === "Icon and name")!;
    const name = dom.window.document.getElementById(
      label.htmlFor,
    ) as HTMLInputElement;
    expect(name.value).toBe("Docs");
    await blur(name);
    expect(blurs).toBe(1);
    expect(name.readOnly).toBe(true);
    expect(name.disabled).toBe(false);
    expect(name.getAttribute("aria-disabled")).toBe("true");
    expect(dom.window.document.querySelector(".animate-spin") !== null).toBe(
      true,
    );
    await blur(name);
    expect(blurs).toBe(1);
    await act(async () => finish());
    expect(name.readOnly).toBe(false);
    expect(name.getAttribute("aria-disabled")).toBeNull();
    expect(dom.window.document.querySelector(".animate-spin")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

const readyEditor = {
  status: "ready" as const,
  onRetry: () => {},
  icon: "",
  name: "Docs",
  description: "",
  onIconChange: async () => {},
  onNameChange: () => {},
  onNameBlur: async () => {},
  onDescriptionChange: () => {},
  onDescriptionBlur: async () => {},
};

test("details show skeleton rows while loading and a retry callout without fields after a failed load", () => {
  setLocale("en", { reload: false });
  const loading = render(
    <SpaceGeneralSection
      path="/repo/docs"
      space={{ gitType: undefined }}
      editor={{ ...readyEditor, status: "loading" }}
    />,
  );
  expect(rowLabels(loading.body)).toEqual(["Type", "Location"]);
  expect(
    loading.querySelectorAll('[data-slot="card"] [data-slot="skeleton"]')
      .length,
  ).toBe(7);
  expect(loading.querySelector("input, textarea")).toBeNull();

  const failed = render(
    <SpaceGeneralSection
      path="/repo/docs"
      editor={{ ...readyEditor, status: "error" }}
    />,
  );
  const callout = failed.querySelector('[data-slot="alert"]')!;
  expect(callout.closest('[data-slot="card"]')).toBeNull();
  expect(callout.textContent).toBe(
    "Couldn't load the detailsRetry before you change anything.Retry",
  );
  expect(rowLabels(failed.body)).toEqual(["Location"]);
  expect(failed.querySelector("input, textarea")).toBeNull();
});

test("health shows a skeleton until the first count and a callout after a failed check", async () => {
  setLocale("en", { reload: false });
  const { SpaceHealthSection } = await import("./space-health-section");
  const loading = render(
    <SpaceHealthSection
      brokenLinksCount={null}
      loading
      failed={false}
      onRefresh={() => {}}
    />,
  );
  expect(loading.querySelector('[data-slot="skeleton"]') !== null).toBe(true);
  expect(loading.querySelector('[data-slot="alert"]')).toBeNull();

  const failed = render(
    <SpaceHealthSection
      brokenLinksCount={null}
      loading={false}
      failed
      onRefresh={() => {}}
    />,
  );
  expect(failed.querySelector('[data-slot="alert"]')?.textContent).toBe(
    "Couldn't check the linksSelect Refresh to check again.",
  );
  expect(failed.querySelector('[data-slot="skeleton"]')).toBeNull();
  expect(failed.querySelector("button")?.textContent).toBe("Refresh");

  const counted = render(
    <SpaceHealthSection
      brokenLinksCount={2}
      loading={false}
      failed={false}
      onRefresh={() => {}}
    />,
  );
  expect(counted.body.textContent?.includes("2 broken")).toBe(true);
});
