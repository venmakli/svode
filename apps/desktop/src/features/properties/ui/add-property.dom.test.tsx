import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

const isolatedProcess = process.env.SVODE_ADD_PROPERTY_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("add property DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ADD_PROPERTY_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  const { isPropertyTypeAddable } = await import("../model/add-column");
  const { PropertyTypeMenuPane } = await import("./schema-column-menu");
  const { propertyTypeAddUnavailableReason } =
    await import("./property-type-meta");
  const m = await import("@/paraglide/messages.js");

  const withSingletons = [
    { name: "Stage", type: "status" as const },
    { name: "Key", type: "unique_id" as const },
  ];

  test("only a second Status or ID cannot be added", () => {
    expect(isPropertyTypeAddable([], "status")).toBe(true);
    expect(isPropertyTypeAddable([], "unique_id")).toBe(true);
    expect(isPropertyTypeAddable(withSingletons, "status")).toBe(false);
    expect(isPropertyTypeAddable(withSingletons, "unique_id")).toBe(false);
    expect(isPropertyTypeAddable(withSingletons, "select")).toBe(true);
    expect(isPropertyTypeAddable(withSingletons, "multi_select")).toBe(true);
    expect(propertyTypeAddUnavailableReason(withSingletons, "status")).toBe(
      m.property_type_add_unavailable({
        type: m.table_property_type_status(),
      }),
    );
  });

  test("add-type pane marks nothing and keeps an existing Status and ID unavailable with the reason", () => {
    const render = (columns: typeof withSingletons | []) => {
      const dom = new JSDOM(
        `<!doctype html><body>${renderToStaticMarkup(
          <PropertyTypeMenuPane
            unavailableReason={(type) =>
              propertyTypeAddUnavailableReason(columns, type)
            }
            onSelect={() => undefined}
          />,
        )}</body>`,
      );
      return rowsByLabel(dom.window.document);
    };

    const blocked = render(withSingletons);
    const status = blocked.get(m.table_property_type_status())!;
    expect(status.disabled).toBe(false);
    expect(status.getAttribute("aria-disabled")).toBe("true");
    expect(
      status.ownerDocument.getElementById(
        status.getAttribute("aria-describedby")!,
      )?.textContent,
    ).toBe(
      m.property_type_add_unavailable({
        type: m.table_property_type_status(),
      }),
    );
    expect(
      blocked
        .get(m.table_property_type_unique_id())
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      blocked
        .get(m.table_property_type_select())
        ?.hasAttribute("aria-disabled"),
    ).toBe(false);
    expect(
      Array.from(blocked.values()).some(
        (row) =>
          row.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
      ),
    ).toBe(false);

    const open = render([]);
    expect(
      Array.from(open.values()).some((row) =>
        row.hasAttribute("aria-disabled"),
      ),
    ).toBe(false);
  });

  test("the change-type pane marks and disables the current type", () => {
    const dom = new JSDOM(
      `<!doctype html><body>${renderToStaticMarkup(
        <PropertyTypeMenuPane
          activeType="select"
          disableActive
          onSelect={() => undefined}
        />,
      )}</body>`,
    );
    const rows = rowsByLabel(dom.window.document);
    const current = rows.get(m.table_property_type_select())!;
    expect(current.disabled).toBe(true);
    expect(
      current.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
    ).toBe(true);
    expect(
      Array.from(rows.values()).filter(
        (row) =>
          row.querySelector('.lucide-check[data-icon="inline-end"]') !== null,
      ).length,
    ).toBe(1);
  });
}

function rowsByLabel(document: Document) {
  const rows = new Map<string, HTMLButtonElement>();
  for (const button of Array.from(document.querySelectorAll("button"))) {
    const label =
      button.querySelector(".font-medium")?.textContent ?? button.textContent;
    if (label) rows.set(label, button);
  }
  return rows;
}
