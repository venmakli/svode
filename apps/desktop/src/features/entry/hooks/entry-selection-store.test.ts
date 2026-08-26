import { expect, test } from "bun:test";
import { useEntrySelectionStore } from "./entry-selection-store";

function resetSelection() {
  useEntrySelectionStore.setState({
    activeDocument: null,
    activeDocumentSpaceId: null,
    activeRevealRequest: null,
    activeScopeOpenRequest: null,
    activePathRetarget: null,
  });
}

test("repeated owner selection is a no-op but an explicit target creates a request", () => {
  resetSelection();
  const { openDocument } = useEntrySelectionStore.getState();

  openDocument("tasks/README.md", "root");
  const firstRequest = useEntrySelectionStore.getState().activeScopeOpenRequest;
  openDocument("tasks/README.md", "root");
  expect(useEntrySelectionStore.getState().activeScopeOpenRequest).toBe(
    firstRequest,
  );

  openDocument("tasks/README.md", "root", {
    scopeOpenIntent: { kind: "target", surfaceId: "collection" },
  });
  const targetRequest =
    useEntrySelectionStore.getState().activeScopeOpenRequest;
  expect(
    Boolean(
      firstRequest && targetRequest && targetRequest.key > firstRequest.key,
    ),
  ).toBe(true);
  expect(targetRequest?.intent).toEqual({
    kind: "target",
    surfaceId: "collection",
  });
});

test("canonical path retarget preserves the current scope session", () => {
  resetSelection();
  const { openDocument, retargetDocument } = useEntrySelectionStore.getState();

  openDocument("tasks/README.md", "root", {
    scopeOpenIntent: { kind: "target", surfaceId: "collection" },
  });
  const openRequest = useEntrySelectionStore.getState().activeScopeOpenRequest;

  retargetDocument("tasks/README.md", "Задачи/README.md", "root");

  const selection = useEntrySelectionStore.getState();
  expect(selection.activeDocument).toBe("Задачи/README.md");
  expect(selection.activeDocumentSpaceId).toBe("root");
  expect(selection.activeScopeOpenRequest).toBe(openRequest);
  expect(selection.activePathRetarget).toEqual({
    key: selection.activePathRetarget?.key,
    fromPath: "tasks/README.md",
    path: "Задачи/README.md",
    spaceId: "root",
  });
});

test("path retarget ignores a stale source identity", () => {
  resetSelection();
  const { openDocument, retargetDocument } = useEntrySelectionStore.getState();

  openDocument("notes.md", "root");
  retargetDocument("tasks.md", "Задачи.md", "root");

  const selection = useEntrySelectionStore.getState();
  expect(selection.activeDocument).toBe("notes.md");
  expect(selection.activePathRetarget).toBeNull();
});

test("repeated scope home selection preserves the original open request", () => {
  resetSelection();
  const { openScopeHome } = useEntrySelectionStore.getState();

  openScopeHome("root");
  const firstRequest = useEntrySelectionStore.getState().activeScopeOpenRequest;
  openScopeHome("root");

  expect(useEntrySelectionStore.getState().activeScopeOpenRequest).toBe(
    firstRequest,
  );
});

test("switching owners applies a fresh default intent", () => {
  resetSelection();
  const { openDocument } = useEntrySelectionStore.getState();

  openDocument("tasks/README.md", "root", {
    scopeOpenIntent: { kind: "target", surfaceId: "collection" },
  });
  const collectionRequest =
    useEntrySelectionStore.getState().activeScopeOpenRequest;
  openDocument("notes/README.md", "root");

  const nextRequest = useEntrySelectionStore.getState().activeScopeOpenRequest;
  expect(nextRequest?.intent).toEqual({ kind: "default" });
  expect(
    Boolean(
      collectionRequest &&
      nextRequest &&
      nextRequest.key > collectionRequest.key,
    ),
  ).toBe(true);
});
