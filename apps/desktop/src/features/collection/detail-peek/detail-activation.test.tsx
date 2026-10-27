import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CollectionDetailRequest } from "./types";
import { createCollectionDetailActivation } from "./detail-activation";

test("detail activation owns selection and merges owner and Collection actions", async () => {
  const requests: CollectionDetailRequest[] = [];
  const activation = createCollectionDetailActivation({
    controller: {
      close: async () => true,
      open: async (request) => {
        requests.push(request);
        return true;
      },
      update: async () => false,
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
      actions: (row) => (
        <button type="button">
          Collection action {(row as { id: string }).id}
        </button>
      ),
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
  expect(actions.includes("Collection action ada@example.test")).toBe(true);
});
