import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyPanel } from "./property-panel";

test("read-only Page properties preserve label geometry and disable mutation controls", () => {
  const markup = renderToStaticMarkup(
    <PropertyPanel
      readOnly
      mode="full"
      spacePath="/repo"
      projectPath="/repo"
      filePath="tasks/task.md"
      entryLabel="Task"
      schemaResult={{
        collectionRootPath: "tasks",
        schema: { columns: [{ name: "Summary", type: "text" }] },
      }}
      values={{ Summary: "Visible value", Legacy: "Visible legacy value" }}
      onValueChange={async () => undefined}
    />,
  );

  expect(markup.includes("Summary")).toBe(true);
  expect(markup.includes("Visible value")).toBe(true);
  expect(markup.includes("Visible legacy value")).toBe(true);
  expect(markup.includes('data-property-label-trigger="Summary"')).toBe(true);
  expect(markup.includes('data-property-type="text"')).toBe(true);
  expect(markup.match(/<button/g)?.length).toBe(1);
  expect(markup.match(/<button[^>]*disabled=""/g)?.length).toBe(1);
  expect(markup.includes('role="button"')).toBe(false);

  const editableMarkup = renderToStaticMarkup(
    <PropertyPanel
      mode="full"
      spacePath="/repo"
      projectPath="/repo"
      filePath="tasks/task.md"
      entryLabel="Task"
      schemaResult={{
        collectionRootPath: "tasks",
        schema: { columns: [{ name: "Summary", type: "text" }] },
      }}
      values={{ Summary: "Visible value" }}
      onValueChange={async () => undefined}
    />,
  );
  const readOnlyLabel = markup.match(
    /<button[^>]*data-property-label-trigger="Summary"[^>]*>/,
  )?.[0];
  const editableLabel = editableMarkup.match(
    /<button[^>]*data-property-label-trigger="Summary"[^>]*>/,
  )?.[0];
  expect(readOnlyLabel?.match(/class="([^"]+)"/)?.[1]).toBe(
    editableLabel?.match(/class="([^"]+)"/)?.[1],
  );
});
