import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
  SettingsOwnerBlock,
  SettingsPage,
  SettingsRow,
} from "./settings-layout";

function render(element: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(element)).window.document;
}

test("page title, group anatomy and row grammar", () => {
  const document = render(
    <SettingsPage title="Profile">
      <SettingsGroup
        title="Author"
        description="Used for commits"
        callout={<div data-callout />}
      >
        <SettingsRow label="Name" htmlFor="name" error="Required">
          <input id="name" />
        </SettingsRow>
        {false}
        <SettingsRow label="Remote URL" layout="stacked">
          <input aria-label="Remote URL" />
        </SettingsRow>
        <SettingsItem
          title="Codex"
          description="Connected"
          actions={<button>Toggle</button>}
        >
          <div data-stacked-content />
        </SettingsItem>
        <SettingsActions>
          <button>Save</button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsPage>,
  );
  expect(document.querySelector("main > header h2")?.textContent).toBe(
    "Profile",
  );
  const section = document.querySelector("section")!;
  const heading = section.querySelector("h3")!;
  expect(heading.textContent).toBe("Author");
  expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
  expect(
    section
      .querySelector("[data-callout]")
      ?.nextElementSibling?.getAttribute("data-slot"),
  ).toBe("card");

  const card = section.querySelector('[data-slot="card"]')!;
  const children = Array.from(card.children).map((node) =>
    node.getAttribute("data-slot"),
  );
  expect(children).toEqual([
    "field",
    "separator",
    "field",
    "separator",
    "item",
    "separator",
    null,
  ]);

  const [inline, stacked] = Array.from(
    card.querySelectorAll('[data-slot="field"]'),
  );
  expect(inline.getAttribute("data-orientation")).toBe("horizontal");
  expect(inline.getAttribute("data-invalid")).toBe("true");
  expect(inline.querySelector('label[for="name"]')?.textContent).toBe("Name");
  expect(inline.querySelector('[data-slot="field-error"]')?.textContent).toBe(
    "Required",
  );
  expect(stacked.getAttribute("data-orientation")).toBe("vertical");
  expect(stacked.lastElementChild?.getAttribute("aria-label")).toBe(
    "Remote URL",
  );

  const item = card.querySelector('[data-slot="item"]')!;
  expect(item.querySelector('[data-slot="item-title"]')?.textContent).toBe(
    "Codex",
  );
  expect(
    item.querySelector('[data-slot="item-actions"] button')?.textContent,
  ).toBe("Toggle");
  expect(item.lastElementChild?.hasAttribute("data-stacked-content")).toBe(
    true,
  );
  expect(card.lastElementChild?.textContent).toBe("Save");
});

test("a new page title resets the scroll offset of the page", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
  );
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
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
  const root = createRoot(dom.window.document.getElementById("app")!);
  const draw = (title: string) =>
    act(async () =>
      root.render(
        <SettingsPage title={title}>
          <div>{title}</div>
        </SettingsPage>,
      ),
    );
  try {
    await draw("MCP");
    const scroller = dom.window.document.querySelector("main > header")!
      .nextElementSibling as HTMLElement;
    scroller.scrollTop = 120;
    await draw("MCP");
    expect(scroller.scrollTop).toBe(120);
    await draw("Shortcuts");
    expect(scroller.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test("group action sits by the title and a group without rows has no card", () => {
  const document = render(
    <SettingsGroup title="Variables" action={<button>Add</button>}>
      {null}
    </SettingsGroup>,
  );
  const section = document.querySelector("section")!;
  expect(section.querySelector("h3")?.textContent).toBe("Variables");
  expect(section.querySelector("button")?.textContent).toBe("Add");
  expect(section.querySelector('[data-slot="card"]')).toBeNull();
});

test("owner block names the owner and nests its groups one level below", () => {
  const document = render(
    <SettingsOwnerBlock
      icon="P"
      title="Testov"
      badges={<span data-badge>Project</span>}
      summary="Remote not set"
    >
      <SettingsGroup title="Variables">
        <SettingsItem title="API_URL" />
      </SettingsGroup>
    </SettingsOwnerBlock>,
  );
  const block = document.querySelector("section")!;
  const title = block.querySelector(":scope > h3 span[id]")!;
  expect(title.textContent).toBe("Testov");
  expect(block.getAttribute("aria-labelledby")).toBe(title.id);
  expect(block.querySelector(":scope > h3 [data-badge]") !== null).toBe(true);
  expect(
    block.querySelector(":scope > h3")?.textContent?.includes("Remote not set"),
  ).toBe(true);
  expect(block.querySelector("section h4")?.textContent).toBe("Variables");
  expect(
    block.querySelector("section h3")?.textContent?.includes("Testov"),
  ).toBe(true);
});

test("a collapsible owner block opens from its header", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true },
  );
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
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <SettingsOwnerBlock
        title="Разработки"
        summary="Stored in Git"
        collapsible={{ open, onOpenChange: setOpen }}
      >
        <div data-body />
      </SettingsOwnerBlock>
    );
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  try {
    await act(async () => root.render(<Harness />));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      "section > h3 > button",
    )!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent?.includes("Stored in Git")).toBe(true);
    expect(dom.window.document.querySelector("[data-body]")).toBeNull();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.window.document.querySelector("[data-body]") !== null).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
