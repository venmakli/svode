import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Page } from "../model/types";
import { PagePropertyPanel } from "./page-property-panel";

function taskPage(extra: Record<string, unknown>): Page {
  return {
    path: "tasks/task.md",
    body: "",
    meta: { title: "Task", icon: null, created: "", updated: "", extra },
  };
}

test("read-only Page properties preserve label geometry and disable mutation controls", () => {
  const markup = renderToStaticMarkup(
    <PagePropertyPanel
      readOnly
      presentation="full"
      spacePath="/repo"
      projectPath="/repo"
      page={taskPage({
        Summary: "Visible value",
        Legacy: "Visible legacy value",
      })}
      schemaResult={{
        collectionRootPath: "tasks",
        schema: { columns: [{ name: "Summary", type: "text" }] },
      }}
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
    <PagePropertyPanel
      presentation="full"
      spacePath="/repo"
      projectPath="/repo"
      page={taskPage({ Summary: "Visible value" })}
      schemaResult={{
        collectionRootPath: "tasks",
        schema: { columns: [{ name: "Summary", type: "text" }] },
      }}
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
