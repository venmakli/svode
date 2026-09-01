import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { restoreAttachmentFocus } from "./attachments-peek";

test("Peek restores focus to the surviving Collection row", async () => {
  const dom = new JSDOM("<!doctype html><button id='row'>Row</button>");
  const row = dom.window.document.querySelector<HTMLButtonElement>("#row");
  if (!row) throw new Error("row fixture missing");

  restoreAttachmentFocus({ returnFocus: () => row, rowId: "page:roadmap.md" });
  await Promise.resolve();

  expect(dom.window.document.activeElement).toBe(row);
  dom.window.close();
});

test("Peek uses the Collection fallback when the activated row disappeared", async () => {
  const dom = new JSDOM("<!doctype html><button id='fallback'>Table</button>");
  const fallback =
    dom.window.document.querySelector<HTMLButtonElement>("#fallback");
  if (!fallback) throw new Error("fallback fixture missing");

  restoreAttachmentFocus({
    fallbackFocus: () => fallback,
    returnFocus: () => null,
    rowId: "page:deleted.md",
  });
  await Promise.resolve();

  expect(dom.window.document.activeElement).toBe(fallback);
  dom.window.close();
});
