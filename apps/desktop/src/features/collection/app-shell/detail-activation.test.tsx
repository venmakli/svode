import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CollectionDetailRequest } from "./types";
import { createCollectionDetailActivation } from "./detail-activation";

test("detail activation owns selection and merges owner and Core actions", async () => {
  const requests: CollectionDetailRequest[] = [];
  const activation = createCollectionDetailActivation({
    controller: {
      close: async () => true,
      open: async (request) => {
        requests.push(request);
        return true;
      },
      prepareForNavigation: async () => true,
    },
    createContent: (row: { id: string }) => ({
      content: row.id,
      description: "Detail",
      headerActions: <button type="button">Owner action</button>,
      title: "Actor",
    }),
    instanceKey: "actors:space:root",
    presentationId: "humans",
  });

  await activation?.(
    { id: "ada@example.test" },
    {
      actions: <button type="button">Core action</button>,
      rowId: "ada@example.test",
    },
  );

  expect(requests[0]?.selection).toEqual({
    instanceKey: "actors:space:root",
    presentationId: "humans",
    rowId: "ada@example.test",
  });
  const actions = renderToStaticMarkup(<>{requests[0]?.headerActions}</>);
  expect(actions.includes("Owner action")).toBe(true);
  expect(actions.includes("Core action")).toBe(true);
});

test("detail activation preserves a guarded controller rejection", async () => {
  let requested = false;
  const activation = createCollectionDetailActivation({
    controller: {
      close: async () => true,
      open: async () => false,
      prepareForNavigation: async () => true,
    },
    createContent: () => ({
      content: null,
      description: null,
      title: null,
    }),
    instanceKey: "routines:space:root",
    onRequested: () => {
      requested = true;
    },
    presentationId: "all",
  });

  await activation?.({}, { rowId: "routine:one" });
  expect(requested).toBe(true);
});
