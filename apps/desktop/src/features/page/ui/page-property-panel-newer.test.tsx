import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeSchema } from "@/features/properties";
import type { CollectionSchemaDto } from "@/platform/properties/properties-api";
import { PagePropertyPanel } from "./page-property-panel";

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

test("the property panel shows a newer property without its menu or editor", () => {
  const schema = normalizeSchema(newerSchemaDto());
  const markup = renderToStaticMarkup(
    <PagePropertyPanel
      presentation="full"
      spacePath="/repo"
      projectPath="/repo"
      page={{
        path: "tasks/task.md",
        body: "",
        meta: {
          title: "Task",
          icon: null,
          created: "",
          updated: "",
          extra: { Summary: "Visible value", Score: 42 },
        },
      }}
      schemaResult={{ collectionRootPath: "tasks", schema }}
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
  expect(markup.match(/data-collection-property-editor=/g)?.length).toBe(2);
});
