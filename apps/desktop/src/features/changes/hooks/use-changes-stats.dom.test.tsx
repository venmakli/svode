import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { FileGitStatus, GitStatus } from "@/features/git";
import type { InspectionScope } from "../model/scope";

// DF-276 R3: a new status object reads only new and changed paths.
test("a new status reads statistics only for new and changed paths and keeps the rest", async () => {
  const dom = await createTestDom();
  const requests: string[][] = [];
  let release: (() => void) | undefined;
  let hold = false;
  mockNativeIpc((command, args) => {
    if (command !== "git_inspection_stats")
      throw new Error(`Unexpected ${command}`);
    const input = args as { paths: string[]; generation: string };
    requests.push(input.paths);
    const response = {
      generation: input.generation,
      items: input.paths.map((path) => ({
        path,
        additions: path.startsWith("gone") ? 0 : requests.length,
        deletions: 1,
      })),
    };
    if (!hold) return response;
    return new Promise((resolve) => {
      release = () => resolve(response);
    });
  });
  const { useChangesStats } = await import("./use-changes-stats");
  const scope: InspectionScope = {
    kind: "repository",
    spacePath: "/space",
    path: "",
  };
  const status = (files: FileGitStatus[]): GitStatus => ({
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: files.length > 0,
    hasConflicts: false,
    tracking: null,
    files,
    totalFiles: files.length,
    omittedFiles: 0,
  });
  const initial: FileGitStatus[] = Array.from({ length: 51 }, (_, index) => ({
    path: `notes/page-${index}.md`,
    state: "untracked",
  }));
  function Stats({ status }: { status: GitStatus }) {
    const paths = status.files.map((file) => file.path);
    const stats = useChangesStats(scope, status, paths);
    return (
      <output>
        {JSON.stringify(
          paths.map((path) => stats.get(path)?.additions ?? "pending"),
        )}
      </output>
    );
  }
  const shownNow = (): (string | number | null)[] =>
    JSON.parse(dom.document.querySelector("output")!.textContent!);
  const settle = () =>
    act(async () => {
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await dom.render(<Stats status={status(initial)} />);
    await settle();
    // Batches of 50 in list order, as before.
    expect(requests.map((paths) => paths.length)).toEqual([50, 1]);
    expect(requests.flat()).toEqual(initial.map((file) => file.path));
    expect(
      shownNow()
        .slice(0, 50)
        .every((value) => value === 1),
    ).toBe(true);
    expect(shownNow()[50]).toBe(2);

    // The same paths and states in a new status object: nothing is read again.
    await dom.render(
      <Stats status={status(initial.map((file) => ({ ...file })))} />,
    );
    await settle();
    expect(requests.length).toBe(2);
    expect(
      shownNow()
        .slice(0, 50)
        .every((value) => value === 1),
    ).toBe(true);

    // A changed state and a new path are read; the rest keep their numbers.
    const changed: FileGitStatus[] = [
      ...initial.map((file, index) =>
        index === 3 ? { ...file, state: "modified" as const } : file,
      ),
      { path: "notes/new.md", state: "untracked" },
    ];
    hold = true;
    await dom.render(<Stats status={status(changed)} />);
    await settle();
    expect(requests.at(-1)).toEqual(["notes/page-3.md", "notes/new.md"]);
    // Until the read returns, the changed path is unknown, the others shown.
    expect(shownNow()[3]).toBe("pending");
    expect(shownNow()[51]).toBe("pending");
    expect(shownNow()[0]).toBe(1);
    await act(async () => {
      release!();
    });
    await settle();
    expect(shownNow()[3]).toBe(3);
    expect(shownNow()[51]).toBe(3);
    expect(requests.length).toBe(3);

    // A path that leaves the list and comes back with the same state is read again.
    hold = false;
    const without = changed.filter((file) => file.path !== "notes/page-0.md");
    await dom.render(<Stats status={status(without)} />);
    await settle();
    expect(requests.length).toBe(3);
    await dom.render(<Stats status={status(changed)} />);
    await settle();
    expect(requests.at(-1)).toEqual(["notes/page-0.md"]);
    expect(shownNow()[0]).toBe(4);
  } finally {
    clearNativeMocks();
    await dom.dispose();
  }
});

test("a failed batch shows unknown statistics and is read again with a new status", async () => {
  const dom = await createTestDom();
  const requests: string[][] = [];
  let fail = true;
  mockNativeIpc((command, args) => {
    if (command !== "git_inspection_stats")
      throw new Error(`Unexpected ${command}`);
    const input = args as { paths: string[]; generation: string };
    requests.push(input.paths);
    if (fail) throw new Error("index.lock");
    return {
      generation: input.generation,
      items: input.paths.map((path) => ({ path, additions: 5, deletions: 2 })),
    };
  });
  const { useChangesStats } = await import("./use-changes-stats");
  const scope: InspectionScope = {
    kind: "repository",
    spacePath: "/space",
    path: "",
  };
  const status = (): GitStatus => ({
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: true,
    hasConflicts: false,
    tracking: null,
    files: [{ path: "a.md", state: "modified" }],
    totalFiles: 1,
    omittedFiles: 0,
  });
  function Stats({ status }: { status: GitStatus }) {
    const stats = useChangesStats(scope, status, ["a.md"]);
    return <output>{JSON.stringify(stats.get("a.md"))}</output>;
  }
  const shownNow = (): unknown =>
    JSON.parse(dom.document.querySelector("output")!.textContent!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await dom.render(<Stats status={status()} />);
    await settle();
    expect(shownNow()).toEqual({
      path: "a.md",
      additions: null,
      deletions: null,
    });
    fail = false;
    await dom.render(<Stats status={status()} />);
    await settle();
    expect(requests.length).toBe(2);
    expect(shownNow()).toEqual({ path: "a.md", additions: 5, deletions: 2 });
  } finally {
    clearNativeMocks();
    await dom.dispose();
  }
});
