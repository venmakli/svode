import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_CHANGED_ITEM_HEADER_DOM !== "1") {
  test("Changes file header keeps its expanded state under its tooltip", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CHANGED_ITEM_HEADER_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  }, 20000);
} else {
  test("the file header gives its expanded state while its tooltip is open", async () => {
    const dom = await createTestDom();
    const { ChangedItemHeader } = await import("./changed-item-header");
    const { Accordion, AccordionItem } =
      await import("@/components/ui/accordion");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const header = (path: string) =>
      dom.document.querySelector<HTMLButtonElement>(
        `[data-changes-item-trigger="${path}"]`,
      )!;
    const expectExpanded = (path: string, expanded: boolean) => {
      const button = header(path);
      expect(button.getAttribute("data-state")).toBe(
        expanded ? "open" : "closed",
      );
      expect(button.getAttribute("aria-expanded")).toBe(String(expanded));
    };
    const tooltip = () => dom.document.querySelector('[role="tooltip"]');
    const hover = async (path: string) => {
      await act(async () => {
        header(path).dispatchEvent(
          new window.MouseEvent("pointermove", { bubbles: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    };
    try {
      await dom.render(
        <TooltipProvider>
          <Accordion type="multiple" defaultValue={["notes/open.md"]}>
            <AccordionItem value="notes/open.md">
              <ChangedItemHeader
                path="notes/open.md"
                name="open.md"
                state="modified"
                stats={{ path: "notes/open.md", additions: 2, deletions: 1 }}
              />
            </AccordionItem>
            <AccordionItem value="notes/closed.md">
              <ChangedItemHeader
                path="notes/closed.md"
                name="closed.md"
                state="untracked"
                stats={{ path: "notes/closed.md", additions: 3, deletions: 0 }}
              />
            </AccordionItem>
          </Accordion>
        </TooltipProvider>,
      );
      expectExpanded("notes/open.md", true);
      expectExpanded("notes/closed.md", false);

      // Hovering the expanded file opens its tooltip with path and state,
      // and the header still gives its expanded state.
      await hover("notes/open.md");
      expect(tooltip()?.textContent).toBe(
        `notes/open.md — ${m.changes_modified()}`,
      );
      expectExpanded("notes/open.md", true);
      expect(header("notes/open.md").getAttribute("aria-label")).toBe(
        `open.md — ${m.changes_modified()} (notes/open.md)`,
      );

      // The same for the collapsed file.
      await hover("notes/closed.md");
      expect(tooltip()?.textContent).toBe(
        `notes/closed.md — ${m.changes_added()}`,
      );
      expectExpanded("notes/closed.md", false);
      expectExpanded("notes/open.md", true);

      // A click on the hovered header expands and collapses the file.
      await act(async () => header("notes/closed.md").click());
      expectExpanded("notes/closed.md", true);
      await act(async () => header("notes/closed.md").click());
      expectExpanded("notes/closed.md", false);
    } finally {
      await dom.render(null);
      await dom.dispose();
    }
  });
}
