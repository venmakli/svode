import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sheet } from "@/components/ui/sheet";

import type { SystemCollectionDetailActiveState } from "../model/detail-controller";
import {
  SystemCollectionDetailDrawerFrame,
  systemCollectionDetailDrawerStyle,
} from "./detail-drawer";

const active: SystemCollectionDetailActiveState = {
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
  expect(systemCollectionDetailDrawerStyle.top).toBe("0.75rem");
  expect(systemCollectionDetailDrawerStyle.right).toBe("0.75rem");
  expect(systemCollectionDetailDrawerStyle.bottom).toBe("0.75rem");
});

test("detail frame keeps accessible semantics, diagnostic, actions, and its own scroll viewport", () => {
  const markup = renderToStaticMarkup(
    <Sheet open>
      <SystemCollectionDetailDrawerFrame
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
  expect(markup.includes("data-system-collection-detail-scroll")).toBe(true);
  expect(markup.includes('role="alert"')).toBe(true);
});

test("pending guard disables explicit close without removing detail content", () => {
  const markup = renderToStaticMarkup(
    <Sheet open>
      <SystemCollectionDetailDrawerFrame
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
