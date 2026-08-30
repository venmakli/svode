import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyPanel } from "./property-panel";

test("read-only Page properties keep values and navigation copy without mutation controls", () => {
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
  expect(markup.includes('data-property-type-icon="text"')).toBe(true);
  expect(markup.includes("data-property-label-trigger")).toBe(false);
  expect(markup.includes("<button")).toBe(false);
  expect(markup.includes('role="button"')).toBe(false);
});
