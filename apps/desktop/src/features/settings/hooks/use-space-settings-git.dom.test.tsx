import { expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

// DF-289 R2: commits during a reload of the Git settings give one reload
// after it, not one per commit.
test("ten commits during a Git settings reload give one following reload", async () => {
  const dom = await createTestDom();
  const path = "/project";
  const status = {
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [],
    hasStaged: false,
    hasUnstaged: false,
    hasConflicts: false,
  };
  let reads = 0;
  let hold = false;
  const held: Array<() => void> = [];
  mockNativeIpc(
    (command) => {
      if (command === "git_get_user_policy") return { autoSync: false };
      if (command === "git_status") return status;
      if (command === "git_get_remote") {
        reads++;
        const remote = "https://example.test/repo.git";
        if (!hold) return remote;
        return new Promise((resolve) => held.push(() => resolve(remote)));
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { useSpaceSettingsGit } = await import("./use-space-settings-git");
  const { emit } = await import("@/platform/native/events");
  function Harness() {
    useSpaceSettingsGit({
      open: true,
      spacePath: path,
      activeRootPath: path,
      isRoot: true,
      spaces: [],
    });
    return null;
  }
  const settle = () =>
    act(async () => {
      for (let turn = 0; turn < 5; turn++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const commit = () =>
    act(async () => {
      await emit("git:committed", { spacePath: path, repoPath: path });
    });
  try {
    await dom.render(<Harness />);
    await settle();
    expect(reads).toBe(1);

    hold = true;
    for (let index = 0; index < 10; index++) await commit();
    await settle();
    expect(reads).toBe(2);
    await act(async () => held.splice(0).forEach((resolve) => resolve()));
    await settle();
    expect(reads).toBe(3);
    await act(async () => held.splice(0).forEach((resolve) => resolve()));
    await settle();
    expect(reads).toBe(3);
  } finally {
    held.splice(0).forEach((resolve) => resolve());
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  }
});

// DF-322 R1: content commits include structural and system commits. A stored
// combination with them off shows as on and is written normalized on the
// next save; turning content commits on writes all three, turning them off
// leaves the other two on and editable.
test("Git automation switches write the effective policy", async () => {
  const dom = await createTestDom();
  const path = "/project";
  const writes: unknown[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "git_get_user_policy") {
        return {
          autoCommitContent: true,
          autoCommitStructural: false,
          autoCommitSystem: false,
          autoSync: false,
        };
      }
      if (command === "git_set_user_policy") {
        writes.push((args as { policy: unknown }).policy);
        return null;
      }
      if (command === "git_status") {
        return {
          branch: "main",
          ahead: 0,
          behind: 0,
          files: [],
          hasStaged: false,
          hasUnstaged: false,
          hasConflicts: false,
        };
      }
      if (command === "git_get_remote") return "https://example.test/repo.git";
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { useSpaceSettingsGit } = await import("./use-space-settings-git");
  let git: ReturnType<typeof useSpaceSettingsGit> | null = null;
  function Harness() {
    const value = useSpaceSettingsGit({
      open: true,
      spacePath: path,
      activeRootPath: path,
      isRoot: true,
      spaces: [],
    });
    useLayoutEffect(() => {
      git = value;
    });
    return null;
  }
  const settle = () =>
    act(async () => {
      for (let turn = 0; turn < 5; turn++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const change = (
    field: Parameters<
      ReturnType<typeof useSpaceSettingsGit>["handlePolicyChange"]
    >[0],
    value: boolean,
  ) =>
    act(async () => {
      await git!.handlePolicyChange(field, value);
    });
  const policy = (
    content: boolean,
    structural: boolean,
    system: boolean,
    sync: boolean,
  ) => ({
    autoCommitContent: content,
    autoCommitStructural: structural,
    autoCommitSystem: system,
    autoSync: sync,
  });
  const shown = () => {
    const current = git!;
    return policy(
      current.autoCommitContent,
      current.autoCommitStructural,
      current.autoCommitSystem,
      current.autoSync,
    );
  };
  try {
    await dom.render(<Harness />);
    await settle();
    expect(git!.loaded).toBe(true);
    expect(shown()).toEqual(policy(true, true, true, false));
    expect(git!.preset).toBe("custom");
    expect(writes).toEqual([]);

    // The next save writes the stored combination normalized.
    await change("autoSync", true);
    expect(writes.at(-1)).toEqual(policy(true, true, true, true));

    // Content off: structural and system stay on and can change again.
    await change("autoCommitContent", false);
    expect(writes.at(-1)).toEqual(policy(false, true, true, true));
    await change("autoCommitStructural", false);
    await change("autoCommitSystem", false);
    expect(writes.at(-1)).toEqual(policy(false, false, false, true));

    // Content on writes all three flags on.
    await change("autoCommitContent", true);
    expect(writes.at(-1)).toEqual(policy(true, true, true, true));
    expect(shown()).toEqual(policy(true, true, true, true));
    expect(writes.length).toBe(5);
  } finally {
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  }
});
