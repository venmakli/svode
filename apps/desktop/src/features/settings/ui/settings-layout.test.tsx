import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import {
  SettingsActions,
  SettingsGroup,
  SettingsItem,
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
