import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyCell } from "./cells";

// DF-237 R4: the cell of a `unique_id` number that another item holds has
// the same mark as an invalid key.
const keyColumn = { name: "Key", type: "unique_id" as const, prefix: "T" };
const other = { path: "tasks/b.md", title: "From B" };

function cell(value: unknown, uniqueIdDuplicate?: typeof other) {
  return renderToStaticMarkup(
    <PropertyCell
      column={keyColumn}
      pageLabel="From A"
      actors={[]}
      onRequestActors={async () => []}
      value={value}
      uniqueIdDuplicate={uniqueIdDuplicate}
      editing={false}
      onEdit={() => undefined}
      onCancel={() => undefined}
      onCommit={() => undefined}
    />,
  );
}

function invalidMark(markup: string) {
  return markup.match(
    /data-table-property-cell[^>]*aria-invalid="true"[^>]*class="([^"]*)"/,
  )?.[1];
}

test("the cell of a repeated number has the invalid key mark", () => {
  expect(invalidMark(cell(3, other))?.includes("ring-destructive")).toBe(true);
  expect(invalidMark(cell(3, other))).toBe(invalidMark(cell("T-3")));
  expect(cell(3, other).includes("T-3")).toBe(true);
  expect(invalidMark(cell(3))).toBe(undefined);
});
