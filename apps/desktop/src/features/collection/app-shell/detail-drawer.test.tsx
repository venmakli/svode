import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sheet } from "@/components/ui/sheet";

import type { CollectionDetailActiveState } from "./detail-controller";
import {
  CollectionDetailDrawerFrame,
  collectionDetailDrawerStyle,
} from "./detail-drawer";

const active: CollectionDetailActiveState = {
  focus: {},
  request: {
    content: <div>Actor details body</div>,
    description: "Repository identity and aliases",
    footerActions: <button type="button">Save actor</button>,
    headerActions: <button type="button">Actor actions</button>,
    selection: {
      instanceKey: "space:root:actors",
      presentationId: "contributors",
      rowId: "person:one",
    },
    title: "Ada Lovelace",
  },
};

test("detail drawer keeps equal top, right, and bottom viewport insets", () => {
  expect(collectionDetailDrawerStyle.top).toBe("0.75rem");
  expect(collectionDetailDrawerStyle.right).toBe("0.75rem");
  expect(collectionDetailDrawerStyle.bottom).toBe("0.75rem");
});

test("detail frame keeps accessible semantics, diagnostic, actions, and its own scroll viewport", () => {
  const markup = renderToStaticMarkup(
    <Sheet open>
      <CollectionDetailDrawerFrame
        active={active}
        diagnostic="Save the actor before leaving"
        pending={false}
        onClose={() => undefined}
      />
    </Sheet>,
  );

  expect(markup.includes("Ada Lovelace")).toBe(true);
  expect(markup.includes("Repository identity and aliases")).toBe(true);
  expect(markup.includes("Actor details body")).toBe(true);
  expect(markup.includes("Save actor")).toBe(true);
  expect(markup.includes("Actor actions")).toBe(true);
  expect(markup.includes("Save the actor before leaving")).toBe(true);
  expect(markup.includes("data-collection-detail-scroll")).toBe(true);
  expect(
    markup.includes("[&amp;_[data-slot=scroll-area-viewport]&gt;div]:!block"),
  ).toBe(true);
  expect(markup.includes('role="alert"')).toBe(true);
});

test("pending guard disables explicit close without removing detail content", () => {
  const markup = renderToStaticMarkup(
    <Sheet open>
      <CollectionDetailDrawerFrame
        active={active}
        diagnostic={null}
        pending
        onClose={() => undefined}
      />
    </Sheet>,
  );

  expect(markup.includes("disabled")).toBe(true);
  expect(markup.includes("Actor details body")).toBe(true);
  expect(markup.includes("animate-spin")).toBe(true);
});
