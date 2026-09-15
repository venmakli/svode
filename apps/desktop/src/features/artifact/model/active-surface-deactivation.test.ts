import { expect, test } from "bun:test";
import {
  prepareActiveContentDeactivation,
  registerActiveContentDeactivation,
  registerSupplementalContentDeactivation,
} from "./active-surface-deactivation";

test("nested peek navigation prepares children and parents, shares a flight and retains blocked parents", async () => {
  const order: string[] = [];
  let allowParent = false;
  const main = registerActiveContentDeactivation(() => {
    order.push("main");
    return "ready";
  });
  const parent = registerSupplementalContentDeactivation(() => {
    order.push("parent");
    return allowParent ? "ready" : "blocked";
  });
  const child = registerSupplementalContentDeactivation(() => {
    order.push("child");
    return "ready";
  });
  try {
    const pending = prepareActiveContentDeactivation();
    expect(prepareActiveContentDeactivation()).toBe(pending);
    expect(await pending).toBe("blocked");
    expect(order).toEqual(["child", "parent"]);
    child();
    order.length = 0;
    allowParent = true;
    expect(await prepareActiveContentDeactivation()).toBe("ready");
    expect(order).toEqual(["parent", "main"]);
  } finally {
    child();
    parent();
    main();
  }
  expect(prepareActiveContentDeactivation()).toBeNull();
});
