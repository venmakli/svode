import { expect, test } from "bun:test";
import type { Entry } from "../model";
import { useEntrySelectionStore } from "./entry-selection-store";

function resetSelection() {
  useEntrySelectionStore.setState({
    activeDocument: null,
    activeDocumentSpaceId: null,
    activeRevealRequest: null,
    activeScopeOpenRequest: null,
    activePathRetarget: null,
    titleOutcomeBySourceKey: {},
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

test("title outcomes remain available to every consumer and chain by path", () => {
  resetSelection();
  const first: Entry = {
    path: "Renamed.md",
    meta: {
      title: "Renamed",
      icon: null,
      created: "created",
      updated: "updated",
      extra: {},
    },
    body: "",
    warnings: [],
  };
  useEntrySelectionStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Untitled.md", first);

  const firstOutcome =
    useEntrySelectionStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Untitled.md"
    ];
  expect(firstOutcome?.entry).toBe(first);
  expect(
    useEntrySelectionStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Untitled.md"
    ],
  ).toBe(firstOutcome);

  const second = {
    ...first,
    path: "Final.md",
    meta: { ...first.meta, title: "Final" },
  };
  useEntrySelectionStore
    .getState()
    .publishTitleOutcome("/tmp/space", "Renamed.md", second);

  expect(
    useEntrySelectionStore.getState().titleOutcomeBySourceKey[
      "/tmp/space\0Renamed.md"
    ]?.entry,
  ).toBe(second);
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
