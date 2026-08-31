import { expect, test } from "bun:test";
import {
  closeActiveContent,
  getActiveContentSelection,
} from "@/features/artifact";
import { openPage } from "./page-navigation-actions";

function resetSelection() {
  closeActiveContent();
}

test("opens a root README through canonical Page intent", () => {
  resetSelection();

  openPage("README.md", "root");
  const selection = getActiveContentSelection().selection;
  expect(
    selection?.kind === "artifact"
      ? selection.request.intent.target
      : null,
  ).toEqual({
    spaceId: "root",
    path: "README.md",
    sourceShape: "directory",
    semanticHint: { kind: "page" },
  });
});

test("routes an ordinary directory-backed README through Page intent", () => {
  resetSelection();

  openPage("notes/README.md", "root");
  const selection = getActiveContentSelection().selection;

  expect(
    selection?.kind === "artifact" ? selection.request.intent.target : null,
  ).toEqual({
    spaceId: "root",
    path: "notes/README.md",
    sourceShape: "directory",
    semanticHint: { kind: "page" },
  });
});
