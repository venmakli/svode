import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_SPACE_ROW_LFS_PLACE_DOM !== "1") {
  test("space row LFS place DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SPACE_ROW_LFS_PLACE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = await createTestDom();
  const doc = dom.document;
  const m = await import("@/paraglide/messages.js");
  const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { useGitStore } = await import("@/features/git");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useSpaceRowGitControls } = await import("./space-row-git-controls");
  type LfsState = import("../model").LfsState;

  const SPACE = "/df369d-project/media";
  const PROJECT = "/df369d-project";

  function Row({ lfsState }: { lfsState: LfsState }) {
    const controls = useSpaceRowGitControls({
      lfsState,
      loading: false,
      refreshing: false,
      rootPath: PROJECT,
      spacePath: SPACE,
    });
    return (
      <>
        <div data-row>{controls.inlineActivity}</div>
        <div data-below>{controls.progress}</div>
      </>
    );
  }

  const render = (lfsState: LfsState) =>
    dom.render(
      <TooltipProvider>
        <Row lfsState={lfsState} />
      </TooltipProvider>,
    );
  const row = () => doc.querySelector("[data-row]")!;
  const below = () => doc.querySelector("[data-below]")!;
  const transferIcon = () =>
    row().querySelector<HTMLElement>("[data-git-transfer]");
  const syncingIcon = () =>
    row().querySelector(`[aria-label="${m.git_status_syncing()}"]`);
  const noAccessIcon = () => row().querySelector(".lucide-cloud-off");
  const mockStatus = (repository?: string) =>
    mockNativeIpc(
      (command) =>
        command === "git_status"
          ? { repository, branch: "main", ahead: 0, behind: 0, files: [] }
          : null,
      { shouldMockEvents: true },
    );

  test("the LFS place shows one icon, a running transfer before no access, beside an unchanged Git indicator", async () => {
    mockStatus();
    const git = useGitStore.getState();
    const previousLocale = getLocale();
    try {
      await setLocale("ru", { reload: false });
      git.updateBackendSyncing(SPACE, true);

      // No transfer: the existing no-access icon beside the Git indicator.
      await render("missing-creds");
      expect(!!noAccessIcon()).toBe(true);
      expect(transferIcon()).toBe(null);
      expect(!!syncingIcon()).toBe(true);
      const gitIndicator = syncingIcon()!.closest("span.size-4")!.outerHTML;

      await act(async () =>
        git.setTransfer(SPACE, {
          direction: "upload",
          file: 1,
          files: 2,
          path: "clips/a-very-long-file-name-of-the-recording-2026-11-19.mov",
          bytes: 12_582_912,
          size: 99_614_720,
        }),
      );
      const upload = transferIcon()!;
      expect(upload.dataset.gitTransfer).toBe("upload");
      expect(upload.getAttribute("role")).toBe("img");
      expect(upload.getAttribute("aria-label")).toBe(
        "Отправка 1 из 2 · a-very-long-file-name-of-the-recording-2026-11-19.mov · 12 из 95 МБ",
      );
      expect(!!upload.querySelector(".lucide-arrow-up")).toBe(true);
      expect(upload.outerHTML.includes("animate-")).toBe(false);
      expect(upload.querySelector("svg")!.classList).toContain(
        "text-muted-foreground",
      );
      // Transfer takes the LFS place; the Git indicator stays as it was, after it.
      expect(noAccessIcon()).toBe(null);
      expect(syncingIcon()!.closest("span.size-4")!.outerHTML).toBe(
        gitIndicator,
      );
      expect(
        upload.compareDocumentPosition(syncingIcon()!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(below().querySelector('[data-slot="progress"]')).toBe(null);

      await act(async () =>
        git.setTransfer(SPACE, {
          direction: "download",
          file: 2,
          files: 6,
          path: "photos/photo.jpg",
          bytes: 314_573,
          size: 419_430,
        }),
      );
      await render("pulling");
      expect(transferIcon()!.getAttribute("aria-label")).toBe(
        "Скачивание 2 из 6 · photo.jpg · 0,3 из 0,4 МБ",
      );
      expect(!!transferIcon()!.querySelector(".lucide-arrow-down")).toBe(true);

      // The end of the transfer clears the place; no download line remains.
      await act(async () => git.setTransfer(SPACE, null));
      expect(transferIcon()).toBe(null);
      expect(doc.body.textContent).not.toContain(
        m.storage_repair_lfs_pulling(),
      );
      expect(below().querySelector('[data-slot="progress"]')).toBe(null);
      await render("missing-creds");
      expect(!!noAccessIcon()).toBe(true);
    } finally {
      await dom.render(null);
      git.setTransfer(SPACE, null);
      git.clear(SPACE);
      clearNativeMocks();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("a Space without its own repository shows the transfer of the project", async () => {
    mockStatus(PROJECT);
    const git = useGitStore.getState();
    try {
      await render("ready");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(useGitStore.getState().statuses[SPACE]?.repository).toBe(PROJECT);
      expect(transferIcon()).toBe(null);
      await act(async () =>
        git.setTransfer(PROJECT, {
          direction: "upload",
          file: 1,
          files: 1,
          path: "video.mov",
          bytes: 0,
          size: 99_614_720,
        }),
      );
      expect(transferIcon()?.dataset.gitTransfer).toBe("upload");
    } finally {
      await dom.render(null);
      git.setTransfer(PROJECT, null);
      git.clear(SPACE);
      clearNativeMocks();
    }
  });
}
