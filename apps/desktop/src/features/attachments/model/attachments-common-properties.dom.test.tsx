import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import type { CollectionInstance } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { AttachmentItem } from "./types";

// The common property "Modified" of Attachments in the DOM: the cell, the
// filter and the sort. Sessions run the same scenario over the same dates
// and expect the same result.
if (process.env.SVODE_ATTACHMENTS_COMMON_PROPERTIES_DOM !== "1") {
  test("Attachments common properties DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ATTACHMENTS_COMMON_PROPERTIES_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  function attachment(name: string, modified: string): AttachmentItem {
    return {
      availability: "available",
      contentPath: `${name}.pdf`,
      displayName: name,
      format: "pdf",
      hasApp: false,
      icon: null,
      key: `document:${name}.pdf`,
      kind: "document",
      modified,
      ownerPath: null,
      path: `${name}.pdf`,
      sizeBytes: 1024,
      sourcePath: `${name}.pdf`,
      sourceShape: "file",
    };
  }
  const attachments: AttachmentItem[] = [
    attachment("Alpha", "2026-09-28"),
    attachment("Beta", "2026-09-29"),
    attachment("Gamma", "2026-09-27"),
  ];
  const names: Record<string, string> = Object.fromEntries(
    attachments.map((item) => [item.key, item.displayName]),
  );

  async function renderAttachments() {
    const dom = await createTestDom();
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionHost, defineCollectionPresentation, useCollectionState } =
      await import("@/features/collection");
    const { createAttachmentsPresentationDescriptor } =
      await import("./presentation");
    const instance: CollectionInstance = {
      defaultPresentationId: "all",
      instanceKey: "attachments:common-properties",
      presentations: [
        defineCollectionPresentation({
          descriptor: createAttachmentsPresentationDescriptor({
            onActivate: () => undefined,
          }),
          state: { phase: "ready", items: attachments },
        }),
      ],
      stateScope: "lifecycle",
    };
    function Host() {
      const state = useCollectionState(instance);
      return state.phase === "ready" ? (
        <TooltipProvider>
          <CollectionHost instance={instance} state={state} />
        </TooltipProvider>
      ) : null;
    }
    await dom.render(<Host />);
    return dom;
  }

  /**
   * Filters and sorts by a property through the query editor of the
   * Collection, as a user does: the options its filter offers, the rows the
   * filter leaves and the rows the sort orders.
   */
  async function queryByProperty(
    document: Document,
    label: string,
    choose: (pane: HTMLElement) => Promise<void>,
  ) {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    const pane = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const rows = () =>
      [...document.querySelectorAll("[data-collection-row]")].map(
        (row) => names[row.getAttribute("data-collection-row")!],
      );
    await clickElement(buttonByText(document, "Filters"));
    await clickElement(buttonByText(pane(), "Add filter"));
    await clickElement(buttonByText(pane(), label));
    const filterOptions = [
      ...pane().querySelectorAll("label [data-slot='badge']"),
    ].map((badge) => badge.textContent);
    await choose(pane());
    await clickElement(buttonByText(pane(), "Apply filter"));
    const filtered = rows();
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Clear filter"));
    await clickElement(buttonByText(document, "Sort"));
    await clickElement(buttonByText(pane(), "Add sort"));
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Apply sort"));
    return { filterOptions, filtered, sorted: rows() };
  }

  test("Modified: the cell, the filter and the sort follow when the item changed", async () => {
    const dom = await renderAttachments();
    const { typeIntoInput } = await import("@/shared/testing/dom-query");
    try {
      const rowText = (key: string) =>
        dom.document.querySelector(`[data-collection-row="${key}"]`)
          ?.textContent ?? "";
      expect(
        attachments.map((item) =>
          ["Sep 28, 2026", "Sep 29, 2026", "Sep 27, 2026"].find((date) =>
            rowText(item.key).includes(date),
          ),
        ),
      ).toEqual(["Sep 28, 2026", "Sep 29, 2026", "Sep 27, 2026"]);
      expect(
        await queryByProperty(dom.document, "Modified", (pane) =>
          typeIntoInput(
            pane.querySelector<HTMLInputElement>('input[type="date"]')!,
            "2026-09-29",
          ),
        ),
      ).toEqual({
        filterOptions: [],
        filtered: ["Beta"],
        sorted: ["Gamma", "Alpha", "Beta"],
      });
    } finally {
      await dom.dispose();
    }
  });
}
