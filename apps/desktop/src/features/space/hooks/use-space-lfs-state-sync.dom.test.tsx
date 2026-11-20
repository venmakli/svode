import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_SPACE_LFS_STATE_SYNC_DOM !== "1") {
  test("space LFS state sync DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SPACE_LFS_STATE_SYNC_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = await createTestDom();
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { emit } = await import("@/platform/native/events");
  const { useSpaceStore } = await import("../model");
  const { useSpaceLfsStateSync } = await import("./use-space-lfs-state-sync");
  type SpaceInfo = import("../model").SpaceInfo;

  const PROJECT = "/df368b-project";
  const space = (id: string): SpaceInfo => ({
    id,
    name: id,
    icon: "",
    description: "",
    path: `${PROJECT}/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  });

  function Sync() {
    useSpaceLfsStateSync(PROJECT);
    return null;
  }

  test("a status event gives its Space or the root Space the state and the files left, and clears them", async () => {
    mockNativeIpc(() => null, { shouldMockEvents: true });
    const previous = useSpaceStore.getState().spaces;
    const previousRoot = useSpaceStore.getState().activeRootLfs;
    const missing = {
      files: [{ path: "clips/video.mov", size: 104_857_600 }],
      bytes: 104_857_600,
      stop: { kind: "stalled" as const },
    };
    const spaceOf = (id: string) =>
      useSpaceStore.getState().spaces.find((item) => item.id === id)!;
    const report = (payload: Record<string, unknown>) =>
      act(async () => {
        await emit("space:lfs_state_changed", payload);
      });
    try {
      useSpaceStore.setState({ spaces: [space("media"), space("docs")] });
      await dom.render(<Sync />);

      await report({
        projectPath: PROJECT,
        spaceId: "media",
        state: "ready",
        missing,
      });
      expect(spaceOf("media").lfsState).toBe("ready");
      expect(spaceOf("media").lfsMissing).toEqual(missing);
      expect(spaceOf("docs").lfsMissing).toBeUndefined();

      // Another project and the project repository leave the Spaces alone...
      await report({
        projectPath: "/other",
        spaceId: "media",
        state: "ready",
        missing: null,
      });
      await report({
        projectPath: PROJECT,
        spaceId: null,
        state: "ready",
        missing: null,
      });
      expect(spaceOf("media").lfsMissing).toEqual(missing);
      // ...and give the root Space, the project repository, its status.
      expect(useSpaceStore.getState().activeRootLfs).toEqual({
        state: "ready",
        missing: null,
      });
      await report({
        projectPath: PROJECT,
        spaceId: null,
        state: "ready",
        missing,
      });
      expect(useSpaceStore.getState().activeRootLfs).toEqual({
        state: "ready",
        missing,
      });

      await report({
        projectPath: PROJECT,
        spaceId: "media",
        state: "ready",
        missing: null,
      });
      expect(spaceOf("media").lfsMissing).toBe(null);
    } finally {
      await dom.render(null);
      useSpaceStore.setState({
        spaces: previous,
        activeRootLfs: previousRoot,
      });
      clearNativeMocks();
    }
  });
}
