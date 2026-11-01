import { expect, test } from "bun:test";
import { act } from "react";
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
