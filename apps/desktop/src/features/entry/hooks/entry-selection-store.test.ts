import { expect, test } from "bun:test";
import { useEntrySelectionStore } from "./entry-selection-store";

function resetSelection() {
  useEntrySelectionStore.setState({
    activeDocument: null,
    activeDocumentSpaceId: null,
    activeRevealRequest: null,
    activeScopeOpenRequest: null,
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
