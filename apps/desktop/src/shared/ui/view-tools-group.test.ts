import { expect, test } from "bun:test";
import { shouldCollapseViewTools } from "./view-tools-group";

test("view tools collapse only once their space is narrower than they are", () => {
  expect(shouldCollapseViewTools(null, 300)).toBe(false);
  expect(shouldCollapseViewTools(200, null)).toBe(false);
  expect(shouldCollapseViewTools(300, 300)).toBe(false);
  expect(shouldCollapseViewTools(299.7, 300)).toBe(false);
  expect(shouldCollapseViewTools(299, 300)).toBe(true);
  expect(shouldCollapseViewTools(120, 300)).toBe(true);
});
