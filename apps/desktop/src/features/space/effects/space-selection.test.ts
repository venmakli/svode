import { expect, test } from "bun:test";
import {
  getActiveContentPath,
  getActiveContentSelection,
  getActiveContentSpaceId,
} from "@/features/artifact";
import { openPage } from "@/features/page/navigation";
import { openScopeHomeSelection } from "./space-selection";

test("ordinary scope open selects the owner instead of its README Page", () => {
  openPage("README.md", "previous");

  openScopeHomeSelection("marketing");

  const selection = getActiveContentSelection();
  expect(selection.selection?.kind).toBe("scope-owner");
  expect(getActiveContentPath()).toBeNull();
  expect(getActiveContentSpaceId()).toBe("marketing");
});
