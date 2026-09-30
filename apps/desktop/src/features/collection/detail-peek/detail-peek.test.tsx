import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Sheet } from "@/components/ui/sheet";

import type { CollectionDetailActiveState } from "./detail-controller";
import { CollectionDetailPeekFrame } from "./detail-peek";

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

function renderFrame(
  state: CollectionDetailActiveState,
  props: { diagnostic?: string | null; pending?: boolean } = {},
) {
  return renderToStaticMarkup(
    <Sheet open>
      <CollectionDetailPeekFrame
        active={state}
        diagnostic={props.diagnostic ?? null}
        pending={props.pending ?? false}
        onClose={() => undefined}
      />
    </Sheet>,
  );
}

test("detail frame keeps accessible semantics, diagnostic, actions, and its own scroll viewport", () => {
  const markup = renderFrame(active, {
    diagnostic: "Save the actor before leaving",
  });

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

test("forms keep the former detail width and readers a reading width", () => {
  const reader = renderFrame(active);
  const form = renderFrame({
    ...active,
    request: { ...active.request, layout: "form" },
  });

  expect(reader.includes("max-w-3xl")).toBe(true);
  expect(reader.includes("max-w-[30rem]")).toBe(false);
  expect(form.includes("max-w-[30rem]")).toBe(true);
  expect(form.includes("max-w-3xl")).toBe(false);
});

test("pending guard disables explicit close without removing detail content", () => {
  const markup = renderFrame(active, { pending: true });

  expect(markup.includes("disabled")).toBe(true);
  expect(markup.includes("Actor details body")).toBe(true);
  expect(markup.includes("animate-spin")).toBe(true);
});
