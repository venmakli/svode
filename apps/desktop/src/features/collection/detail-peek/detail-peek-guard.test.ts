import { expect, test } from "bun:test";

import { prepareActiveContentDeactivation } from "@/features/artifact";

import { collectionDetailController } from "./detail-peek";

const selection = {
  instanceKey: "routines:space:root",
  presentationId: "all",
  rowId: "routine:daily",
};

test("navigation passes the guard of the open detail and closes it", async () => {
  let allowClose = false;
  let guardCalls = 0;
  await collectionDetailController.open({
    canClose: () => {
      guardCalls += 1;
      return allowClose;
    },
    content: "Daily digest form",
    description: "Edit routine",
    layout: "form",
    selection,
    title: "Daily digest",
  });

  expect(await prepareActiveContentDeactivation()).toBe("blocked");
  expect(guardCalls).toBe(1);

  allowClose = true;
  expect(await prepareActiveContentDeactivation()).toBe("ready");
  expect(guardCalls).toBe(2);

  // The closed detail no longer takes part in navigation.
  expect(prepareActiveContentDeactivation()).toBeNull();
  expect(await collectionDetailController.close(selection)).toBe(true);
  expect(guardCalls).toBe(2);
});
