import { expect, test } from "bun:test";
import {
  getActiveEntrySelection,
  openEntryDocument,
} from "@/features/entry/selection";
import { openScopeHomeSelection } from "./space-selection";

test("ordinary scope open selects the owner instead of its README document", () => {
  openEntryDocument("README.md", "previous");

  openScopeHomeSelection("marketing");

  expect(getActiveEntrySelection()).toMatchObject({
    activeDocument: null,
    activeDocumentSpaceId: "marketing",
  });
});
