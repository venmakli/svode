import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import type { CollectionSchemaPanel } from "../hooks/use-collection-schema-panel";
import {
  defineComputedCollectionProperty,
  defineDomainSpecificCollectionProperty,
  defineSchemaBackedCollectionProperty,
} from "../model/collection-property";
import type { CollectionPropertyPanelConflict } from "../model/collection-property-conflict";
import type { Column } from "../model/types";
import { CollectionPropertyPanel } from "./collection-property-panel";
import { CollectionPropertyValue } from "./collection-property-value";

interface Item {
  name: string;
  problems: readonly string[];
  secret: boolean;
}

const item: Item = { name: "review", problems: [], secret: false };

const name = defineComputedCollectionProperty<Item>({
  featureId: "test",
  getValue: (item) => item.name,
  key: "name",
  label: "Name",
  standard: { type: "text" },
});
const state = defineDomainSpecificCollectionProperty<Item>({
  featureId: "test",
  getValue: (item) => item.problems,
  key: "state",
  label: "State",
  render: (_value, item) =>
    item.problems.length > 0 ? <span>cell problems</span> : null,
  renderDetail: (_value, item) =>
    item.problems.length > 0 ? (
      <ul>
        {item.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    ) : null,
});
const hidden = defineDomainSpecificCollectionProperty<Item>({
  featureId: "test",
  getApplicability: (item) =>
    item.secret ? { status: "applicable" } : { status: "hidden" },
  getValue: () => "x",
  key: "hidden",
  label: "Hidden",
  render: () => "x",
});

test("the panel renders the property definitions in order with their type icons", () => {
  const html = renderToStaticMarkup(
    <CollectionPropertyPanel
      properties={[name, state, hidden]}
      item={{ ...item, problems: ["Name mismatch"] }}
    />,
  );

  expect(html.includes("data-collection-property-panel")).toBe(true);
  expect(
    html.indexOf('data-collection-panel-property="name"') <
      html.indexOf('data-collection-panel-property="state"'),
  ).toBe(true);
  expect(html.includes(">review<")).toBe(true);
  expect(html.includes("lucide-type")).toBe(true);
  // A hidden property has no row.
  expect(html.includes('data-collection-panel-property="hidden"')).toBe(false);
});

test("an empty read-only property is not shown", () => {
  const html = renderToStaticMarkup(
    <CollectionPropertyPanel
      properties={[name, state]}
      item={{ ...item, name: "" }}
    />,
  );
  expect(html).toBe("");
});

test("a custom property shows its detail render in the panel and its render in a cell", () => {
  const problemItem = { ...item, problems: ["Name mismatch"] };
  const panel = renderToStaticMarkup(
    <CollectionPropertyPanel properties={[state]} item={problemItem} />,
  );
  expect(panel.includes("<li>Name mismatch</li>")).toBe(true);
  expect(panel.includes("cell problems")).toBe(false);

  const cell = renderToStaticMarkup(
    <CollectionPropertyValue property={state as never} item={problemItem} />,
  );
  expect(cell).toBe("<span>cell problems</span>");
  expect(
    renderToStaticMarkup(
      <CollectionPropertyValue property={state as never} item={item} />,
    ),
  ).toBe("");
});

test("facts follow the properties under their group label and empty facts are not shown", () => {
  const html = renderToStaticMarkup(
    <CollectionPropertyPanel
      factGroups={[
        {
          facts: [
            {
              key: "license",
              label: "License",
              value: { kind: "text", text: " " },
            },
            {
              key: "tools",
              label: "Tools",
              value: { items: ["Read", "Bash(git log:*)"], kind: "list" },
            },
            {
              key: "path",
              label: "Path",
              value: { kind: "path", path: "~/x" },
            },
            {
              key: "command",
              label: "Command",
              value: { code: "npx -y server --flag", kind: "code" },
            },
            {
              key: "managed",
              label: "Managed",
              value: { kind: "link", label: "Providers", onSelect: () => {} },
            },
          ],
          key: "source",
          label: "From SKILL.md",
        },
        {
          facts: [
            {
              key: "empty",
              label: "Empty",
              value: { items: [], kind: "list" },
            },
          ],
          key: "empty-group",
          label: "Empty group",
        },
      ]}
      properties={[name]}
      item={item}
    />,
  );

  const groupIndex = html.indexOf('data-collection-panel-fact-group="source"');
  expect(
    groupIndex > html.indexOf('data-collection-panel-property="name"'),
  ).toBe(true);
  expect(html.includes(">From SKILL.md<")).toBe(true);
  expect(html.includes('data-collection-panel-fact="license"')).toBe(false);
  expect(html.includes(">Bash(git log:*)<")).toBe(true);
  expect(html.includes("<code")).toBe(true);
  expect(html.includes("npx -y server --flag")).toBe(true);
  expect(html.includes(">Providers<")).toBe(true);
  expect(html.includes("Empty group")).toBe(false);
});

test("a panel without visible rows renders nothing", () => {
  expect(
    renderToStaticMarkup(
      <CollectionPropertyPanel properties={[hidden]} item={item} />,
    ),
  ).toBe("");
});

// DF-300: a schema label is stretched over its grid row no higher than the
// first line of its value, a line of text or a control under the padding of
// its cell, so a taller row leaves it at the top, level with that line, in
// the ordinary and the conflict mode; a label without a schema and the
// conflict label keep theirs.
const statusColumn: Column = { name: "Status", type: "text" };
const assigneeColumn: Column = { name: "Assignee", type: "text" };
const schemaProperty = (column: Column) =>
  defineSchemaBackedCollectionProperty<Item>({
    capabilities: {
      edit: { getState: () => ({ status: "idle" }), update: () => {} },
    },
    column,
    getValue: (item) => item.name,
  });
const schemaProperties = [
  schemaProperty(statusColumn),
  schemaProperty(assigneeColumn),
];
const schemaPanel = {
  schema: { columns: [statusColumn, assigneeColumn] },
  openColumn: null,
  orphanEntries: [],
  uniqueIdDuplicate: null,
  collectionRootPath: "tasks",
  spacePath: "/space",
  projectPath: null,
  setOpenColumn: () => {},
  applyCollectionSchema: () => {},
} as unknown as CollectionSchemaPanel;

/** The label of a row: its first grid item, before the value cell. */
function gridLabel(html: string, key: string) {
  const row = new JSDOM(html).window.document.querySelector(
    `[data-collection-panel-property="${key}"]`,
  );
  return row!.firstElementChild!;
}

test("a schema label is no higher than the first line of its value", () => {
  for (const readOnly of [false, true]) {
    const html = renderToStaticMarkup(
      <CollectionPropertyPanel
        layout="wide"
        properties={schemaProperties}
        item={item}
        readOnly={readOnly}
        schemaPanel={schemaPanel}
      />,
    );
    const label = gridLabel(html, "Status");
    expect(label.querySelector("[data-property-label-trigger]") !== null).toBe(
      true,
    );
    // A control sits under the padding of its cell, text is one line.
    expect(label.classList.contains("max-h-11")).toBe(!readOnly);
    expect(label.classList.contains("max-h-8")).toBe(readOnly);
  }
});

test("in conflict mode a merged schema label is no higher than its line beside a disputed one", () => {
  const variant = { item, deleted: false, text: "review" };
  const conflict: CollectionPropertyPanelConflict<Item> = {
    disputed: [
      {
        key: "Assignee",
        label: "Assignee",
        ours: variant,
        theirs: variant,
        decision: null,
        decidedText: "",
      },
    ],
    accepted: false,
    pending: false,
    readOnly: false,
    onChoose: () => {},
    onReopen: () => {},
    onAccept: () => {},
  };
  const html = renderToStaticMarkup(
    <CollectionPropertyPanel
      conflict={conflict}
      layout="wide"
      properties={schemaProperties}
      item={item}
      schemaPanel={schemaPanel}
    />,
  );
  const merged = gridLabel(html, "Status");
  expect(merged.querySelector("[data-property-label-trigger]") !== null).toBe(
    true,
  );
  // The merged values are read only, as text.
  expect(merged.classList.contains("max-h-8")).toBe(true);
  // The disputed label stays inside the conflict label, on its mark's line.
  const disputed = gridLabel(html, "Assignee");
  expect(disputed.hasAttribute("data-collection-panel-conflict-label")).toBe(
    true,
  );
  expect(disputed.classList.contains("items-start")).toBe(true);
  expect(disputed.firstElementChild!.querySelector("svg") !== null).toBe(true);
  expect(disputed.querySelector("[data-property-label-trigger]") !== null).toBe(
    true,
  );
});

test("a label without a schema keeps its alignment", () => {
  const html = renderToStaticMarkup(
    <CollectionPropertyPanel properties={[name]} item={item} />,
  );
  const label = gridLabel(html, "name");
  expect(label.classList.contains("items-start")).toBe(true);
  expect(label.className.includes("max-h-")).toBe(false);
});
