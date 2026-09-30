import { expect, test } from "bun:test";
import { holdOrder } from "./stable-order";

test("held order keeps known ids in place, drops gone ones and appends new", () => {
  expect(holdOrder(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "c", "d"]);
  expect(holdOrder([], ["b", "a"])).toEqual(["b", "a"]);
});
