import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

test("a Collection with its schema in conflict leads to the schema in Changes", async () => {
  const dom = await createTestDom();
  const { SchemaConflict } = await import("./schema-conflict");
  const { registerConflictNavigation, useGitPathInConflict } =
    await import("@/features/git/app-shell");
  const { useGitStore } = await import("@/features/git");
  const m = await import("@/paraglide/messages.js");
  const opened: unknown[] = [];
  const unregister = registerConflictNavigation({
    openFile: (target) => opened.push(target),
    openPage: () => {},
  });
  function Screen() {
    const conflicted = useGitPathInConflict("/project", "tasks/schema.yaml");
    return conflicted ? (
      <SchemaConflict spacePath="/project" schemaPath="tasks/schema.yaml" />
    ) : (
      <p data-views>views</p>
    );
  }
  const status = (state: "conflict" | "modified") => ({
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: true,
    hasConflicts: state === "conflict",
    tracking: null,
    files: [{ path: "tasks/schema.yaml", state }],
    totalFiles: 1,
    omittedFiles: 0,
  });
  try {
    useGitStore.getState().applyStatus("/project", status("modified"));
    await dom.render(<Screen />);
    expect(!!dom.document.querySelector("[data-views]")).toBe(true);
    await act(async () => {
      useGitStore.getState().applyStatus("/project", status("conflict"));
    });
    const empty = dom.document.querySelector(
      "[data-collection-schema-conflict]",
    )!;
    expect(
      empty.textContent?.includes(m.collection_schema_conflict_title()),
    ).toBe(true);
    await act(async () => {
      empty.querySelector("button")!.click();
    });
    expect(opened).toEqual([
      { spacePath: "/project", path: "tasks/schema.yaml" },
    ]);
  } finally {
    unregister();
    useGitStore.getState().clear("/project");
    await dom.render(null);
    await dom.dispose();
  }
});
