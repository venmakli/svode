import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

const isolatedProcess = process.env.SVODE_COLUMN_MENU_PANES_PROCESS === "1";

if (!isolatedProcess) {
  test("Table schema menu extension scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLUMN_MENU_PANES_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  const { TableSchemaMenuExtension } = await import("./column-menu-panes");
  const m = await import("@/paraglide/messages.js");

  test("Table extends the common schema menu with view-local actions", () => {
    const markup = renderToStaticMarkup(
      <TableSchemaMenuExtension
        field="Published"
        visibleFields={["title", "Published"]}
        filter={null}
        sort={null}
        onUpdateViewPatch={async () => undefined}
        controls={{ close: () => undefined, openPane: () => undefined }}
      />,
    );

    expect(markup.includes(m.table_hide_column())).toBe(true);
    expect(markup.includes(m.table_filter())).toBe(true);
    expect(markup.includes(m.view_query_sort_title())).toBe(true);
    expect(markup.includes(m.table_duplicate_column())).toBe(false);
    expect(markup.includes(m.table_delete_column())).toBe(false);
  });
}
