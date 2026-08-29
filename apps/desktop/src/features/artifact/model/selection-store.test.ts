import { expect, test } from "bun:test";
import { useArtifactSelectionStore } from "./selection-store";

function resetSelection() {
  useArtifactSelectionStore.setState({
    selection: null,
    activeRevealRequest: null,
    activePathRetarget: null,
  });
}

test("keeps structural owner selection separate from explicit Artifact intent", () => {
  resetSelection();
  const { openScopeOwner, openArtifact } = useArtifactSelectionStore.getState();

  openScopeOwner({ kind: "space", spaceId: "root" });
  const spaceSelection = useArtifactSelectionStore.getState().selection;
  expect(spaceSelection?.kind).toBe("scope-owner");
  expect(
    spaceSelection?.kind === "scope-owner"
      ? spaceSelection.request.owner
      : null,
  ).toEqual({ kind: "space", spaceId: "root" });

  openScopeOwner({
    kind: "collection",
    spaceId: "root",
    path: "tasks/README.md",
  });
  const collectionSelection = useArtifactSelectionStore.getState().selection;
  expect(collectionSelection?.kind).toBe("scope-owner");
  expect(
    collectionSelection?.kind === "scope-owner"
      ? collectionSelection.request.owner
      : null,
  ).toEqual({
    kind: "collection",
    spaceId: "root",
    path: "tasks/README.md",
  });

  openArtifact({
    spaceId: "root",
    path: "notes.md",
    sourceShape: "file",
    semanticHint: { kind: "page" },
  });
  const artifactSelection = useArtifactSelectionStore.getState().selection;
  expect(artifactSelection?.kind).toBe("artifact");
  expect(
    artifactSelection?.kind === "artifact"
      ? artifactSelection.request.intent.target
      : null,
  ).toEqual({
    spaceId: "root",
    path: "notes.md",
    sourceShape: "file",
    semanticHint: { kind: "page" },
  });
});

test("repeated selection is a no-op unless it carries an explicit request", () => {
  resetSelection();
  const { openScopeOwner } = useArtifactSelectionStore.getState();
  const owner = {
    kind: "collection" as const,
    spaceId: "root",
    path: "tasks/README.md",
  };

  openScopeOwner(owner);
  const first = useArtifactSelectionStore.getState().selection;
  openScopeOwner(owner);
  expect(useArtifactSelectionStore.getState().selection).toBe(first);

  openScopeOwner(owner, {
    scopeOpenIntent: { kind: "target", surfaceId: "collection" },
  });
  const targeted = useArtifactSelectionStore.getState().selection;
  expect(targeted === first).toBe(false);
  expect(
    targeted?.kind === "scope-owner" ? targeted.request.intent : null,
  ).toEqual({ kind: "target", surfaceId: "collection" });
});

test("retarget preserves an owner session and refreshes an Artifact request marker", () => {
  resetSelection();
  const store = useArtifactSelectionStore.getState();
  store.openArtifact({
    spaceId: "root",
    path: "draft.md",
    sourceShape: "file",
    semanticHint: { kind: "page" },
  });
  const first = useArtifactSelectionStore.getState().selection;
  const firstKey = first?.kind === "artifact" ? first.request.key : null;

  store.retarget("draft.md", "notes/README.md", "root");
  const next = useArtifactSelectionStore.getState();
  expect(
    next.selection?.kind === "artifact"
      ? next.selection.request.intent.target
      : null,
  ).toEqual({
    spaceId: "root",
    path: "notes/README.md",
    sourceShape: "directory",
    semanticHint: { kind: "page" },
  });
  expect(
    next.selection?.kind === "artifact" &&
      next.selection.request.key > (firstKey ?? 0),
  ).toBe(true);
  expect(next.activePathRetarget).toEqual({
    key: next.activePathRetarget?.key,
    fromPath: "draft.md",
    path: "notes/README.md",
    spaceId: "root",
  });
});

test("rejects absolute and traversal targets before they reach an adapter", () => {
  resetSelection();
  const { openArtifact } = useArtifactSelectionStore.getState();

  for (const path of ["../secret.md", "/tmp/secret.md"]) {
    let rejected = false;
    try {
      openArtifact({
        spaceId: "root",
        path,
        sourceShape: "file",
        semanticHint: { kind: "page" },
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }
});
