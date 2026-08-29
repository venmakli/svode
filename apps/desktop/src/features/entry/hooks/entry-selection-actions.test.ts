import { expect, test } from "bun:test";
import {
  closeActiveContent,
  getActiveContentSelection,
} from "@/features/artifact";
import { openEntryDocument } from "./entry-selection-actions";

function resetSelection() {
  closeActiveContent();
}

test("routes structural README owners before Page Artifact resolution", () => {
  resetSelection();

  openEntryDocument("README.md", "root");
  const spaceSelection = getActiveContentSelection().selection;
  expect(
    spaceSelection?.kind === "scope-owner"
      ? spaceSelection.request.owner
      : null,
  ).toEqual({ kind: "space", spaceId: "root" });

  openEntryDocument("tasks/README.md", "root", {
    scopeOpenIntent: { kind: "target", surfaceId: "collection" },
  });
  const collectionSelection = getActiveContentSelection().selection;
  expect(
    collectionSelection?.kind === "scope-owner"
      ? collectionSelection.request.owner
      : null,
  ).toEqual({
    kind: "collection",
    spaceId: "root",
    path: "tasks/README.md",
  });
});

test("routes an ordinary directory-backed README through Page intent", () => {
  resetSelection();

  openEntryDocument("notes/README.md", "root");
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
