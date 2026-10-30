import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CollectionSchemaDto } from "@/platform/properties/properties-api";
import {
  colorStyle,
  hasNewerStatusGroup,
  isSensitiveColumn,
  normalizeSchema,
  optionColor,
} from "../lib/utils";
import type { ColorName, Column, StatusGroup } from "../model/types";
import { validatePropertyValue } from "../model/validation";
import { PropertyControl } from "./property-control";
import { PropertyPanel } from "./property-panel";
import { PropertyValue } from "./property-value";

// A schema as Desktop gets it when a newer Svode version changed the file.
function newerSchemaDto(): CollectionSchemaDto {
  return {
    columns: [
      { name: "Summary", type: "text" },
      { name: "Score", type: "formula", expression: "1 + 1" },
      {
        name: "Links",
        type: "relation",
        relation: "people",
        limit: "many",
      },
      {
        name: "Owner",
        type: "relation",
        relation: "people",
        relation_scope: { type: "root", x_note: "kept" },
      },
    ] as unknown as CollectionSchemaDto["columns"],
    views: [{ name: "Timeline", type: "timeline" }],
    newer_svode: { columns: ["Score", "Links"], views: ["Timeline"] },
  };
}

test("normalizeSchema marks properties of a newer version and keeps the marker", () => {
  const schema = normalizeSchema(newerSchemaDto());
  const byName = new Map(schema.columns.map((column) => [column.name, column]));

  expect(schema.newerSvode).toEqual({
    columns: ["Score", "Links"],
    views: ["Timeline"],
  });
  expect(byName.get("Summary")?.newer).toBe(undefined);
  expect(byName.get("Score")?.newer).toBe(true);
  expect(byName.get("Score")?.type).toBe("text");
  expect(byName.get("Links")?.newer).toBe(true);
  expect(byName.get("Links")?.type).toBe("relation");
  expect(byName.get("Owner")?.newer).toBe(undefined);
  expect(byName.get("Owner")?.relationScope).toBe("root");

  const again = normalizeSchema(schema);
  expect(again.columns.map((column) => column.newer === true)).toEqual([
    false,
    true,
    true,
    false,
  ]);
});

test("a column of an unknown type is newer even without the marker", () => {
  const schema = normalizeSchema({
    columns: [{ name: "Score", type: "formula" }],
  } as unknown as CollectionSchemaDto);

  expect(schema.columns[0]?.newer).toBe(true);
  expect(schema.columns[0]?.type).toBe("text");
});

test("values of a newer property render read-only as text, known ones as before", () => {
  const schema = normalizeSchema(newerSchemaDto());
  const [summary, score, links] = schema.columns as [Column, Column, Column];

  const linksValue = renderToStaticMarkup(
    <PropertyValue column={links} value={["people/ann.md", "people/bo.md"]} />,
  );
  expect(linksValue).toBe(
    '<span data-newer-property-value="true">people/ann.md, people/bo.md</span>',
  );

  const scoreControl = renderToStaticMarkup(
    <PropertyControl column={score} value={2} onChange={() => undefined} />,
  );
  expect(scoreControl).toBe('<span data-newer-property-value="true">2</span>');
  expect(validatePropertyValue(links, { odd: true })).toEqual({
    invalid: false,
  });

  const summaryControl = renderToStaticMarkup(
    <PropertyControl
      column={summary}
      value="Visible"
      onChange={() => undefined}
    />,
  );
  expect(summaryControl.includes("data-newer-property-value")).toBe(false);
  expect(summaryControl.includes("<input")).toBe(true);
});

test("the property panel shows a newer property without its menu or editor", () => {
  const schema = normalizeSchema(newerSchemaDto());
  const markup = renderToStaticMarkup(
    <PropertyPanel
      mode="full"
      spacePath="/repo"
      projectPath="/repo"
      filePath="tasks/task.md"
      pageLabel="Task"
      schemaResult={{ collectionRootPath: "tasks", schema }}
      values={{ Summary: "Visible value", Score: 42 }}
      onValueChange={async () => undefined}
    />,
  );

  expect(markup.includes('data-newer-property="Score"')).toBe(true);
  expect(markup.includes('data-newer-property="Links"')).toBe(true);
  expect(markup.includes('data-property-label-trigger="Score"')).toBe(false);
  expect(markup.includes('data-property-label-trigger="Summary"')).toBe(true);
  expect(markup.includes('data-property-label-trigger="Owner"')).toBe(true);
  expect(
    markup.includes(
      "Score: Property of a newer Svode version. Update Svode to change it.",
    ),
  ).toBe(true);
  expect(
    markup.includes('<span data-newer-property-value="true">42</span>'),
  ).toBe(true);
  // Only the known properties open an editor.
  expect(markup.match(/role="button"/g)?.length).toBe(2);
});

test("values a newer version set inside known objects draw as the default", () => {
  const teal = "teal" as ColorName;

  expect(colorStyle(teal, "blue")).toEqual(colorStyle("blue"));
  expect(colorStyle(teal)).toEqual(colorStyle("neutral"));
  expect(optionColor({ name: "Later", color: teal })).toBe("neutral");
  expect(
    isSensitiveColumn({
      name: "Note",
      type: "text",
      sensitivity: "secret" as Column["sensitivity"],
    }),
  ).toBe(true);
  expect(
    isSensitiveColumn({ name: "Email", type: "email", sensitivity: "none" }),
  ).toBe(false);
  expect(isSensitiveColumn({ name: "Email", type: "email" })).toBe(true);

  const status: Column = {
    name: "Stage",
    type: "status",
    options: [
      { name: "Open", group: "todo" },
      { name: "Blocked", group: "blocked" as StatusGroup },
    ],
  };
  expect(hasNewerStatusGroup(status)).toBe(true);
  expect(
    hasNewerStatusGroup({ ...status, options: status.options?.slice(0, 1) }),
  ).toBe(false);
});
