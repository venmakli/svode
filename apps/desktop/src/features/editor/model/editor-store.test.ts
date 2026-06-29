import { expect, test } from "bun:test";
import { useEditorStore } from "./editor-store";

const COMPLIANCE_SPACE = "/tmp/project/spaces/compliance";
const SUPPORT_SPACE = "/tmp/project/spaces/support";

test("editor pending write markers are scoped by space path", () => {
  resetEditorStore();

  useEditorStore.getState().markUnsaved(COMPLIANCE_SPACE, "AGENTS.md");

  expect(
    useEditorStore.getState().hasUnsaved(COMPLIANCE_SPACE, "AGENTS.md"),
  ).toBe(true);
  expect(useEditorStore.getState().hasUnsaved(SUPPORT_SPACE, "AGENTS.md")).toBe(
    false,
  );
});

test("clearing a scoped pending write does not clear same path in another space", () => {
  resetEditorStore();

  const store = useEditorStore.getState();
  store.markUnsaved(COMPLIANCE_SPACE, "AGENTS.md");
  store.markUnsaved(SUPPORT_SPACE, "AGENTS.md");

  store.clearUnsaved(COMPLIANCE_SPACE, "AGENTS.md");

  expect(store.hasUnsaved(COMPLIANCE_SPACE, "AGENTS.md")).toBe(false);
  expect(store.hasUnsaved(SUPPORT_SPACE, "AGENTS.md")).toBe(true);
});

function resetEditorStore() {
  useEditorStore.setState({
    unsavedChanges: {},
    aiModified: {},
    staleCache: {},
    pendingRename: null,
    brokenLinks: new Set<string>(),
    suppressedPaths: new Set<string>(),
  });
}
