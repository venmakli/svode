import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  defineComputedCollectionProperty,
  defineDomainSpecificCollectionProperty,
} from "../model/collection-property";
import { CollectionPropertyPanel } from "./collection-property-panel";
import { CollectionPropertyValue } from "./collection-property-value";

interface Row {
  name: string;
  problems: readonly string[];
  secret: boolean;
}

const row: Row = { name: "review", problems: [], secret: false };

const name = defineComputedCollectionProperty<Row>({
  featureId: "test",
  getValue: (item) => item.name,
  key: "name",
  label: "Name",
  standard: { type: "text" },
});
const state = defineDomainSpecificCollectionProperty<Row>({
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
const hidden = defineDomainSpecificCollectionProperty<Row>({
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
    <CollectionPropertyPanel properties={[name, state, hidden]} row={row} />,
  );

  expect(html.includes("data-collection-property-panel")).toBe(true);
  expect(
    html.indexOf('data-collection-panel-property="name"') <
      html.indexOf('data-collection-panel-property="state"'),
  ).toBe(true);
  expect(html.includes(">review<")).toBe(true);
  expect(html.includes("lucide-type")).toBe(true);
  // A hidden property has no row; an empty custom value reads as "-".
  expect(html.includes('data-collection-panel-property="hidden"')).toBe(false);
  expect(html.includes(">-<")).toBe(true);
});

test("a custom property shows its detail render in the panel and its render in a cell", () => {
  const problemRow = { ...row, problems: ["Name mismatch"] };
  const panel = renderToStaticMarkup(
    <CollectionPropertyPanel properties={[state]} row={problemRow} />,
  );
  expect(panel.includes("<li>Name mismatch</li>")).toBe(true);
  expect(panel.includes("cell problems")).toBe(false);

  const cell = renderToStaticMarkup(
    <CollectionPropertyValue property={state as never} row={problemRow} />,
  );
  expect(cell).toBe("<span>cell problems</span>");
  expect(
    renderToStaticMarkup(
      <CollectionPropertyValue property={state as never} row={row} />,
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
      row={row}
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
      <CollectionPropertyPanel properties={[hidden]} row={row} />,
    ),
  ).toBe("");
});
