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
  type LfsMissing = import("../model").LfsMissing;
  type LfsUnsent = import("../model").LfsUnsent;

  const SPACE = "/df369d-project/media";
  const PROJECT = "/df369d-project";

  function Row({
    lfsState,
    lfsMissing,
    lfsUnsent,
  }: {
    lfsState: LfsState;
    lfsMissing: LfsMissing | null;
    lfsUnsent: LfsUnsent | null;
  }) {
    const controls = useSpaceRowGitControls({
      lfsState,
      lfsMissing,
      lfsUnsent,
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

  const render = (
    lfsState: LfsState,
    lfsMissing: LfsMissing | null = null,
    lfsUnsent: LfsUnsent | null = null,
  ) =>
    dom.render(
      <TooltipProvider>
        <Row
          lfsState={lfsState}
          lfsMissing={lfsMissing}
          lfsUnsent={lfsUnsent}
        />
      </TooltipProvider>,
    );
  const row = () => doc.querySelector("[data-row]")!;
  const below = () => doc.querySelector("[data-below]")!;
  const transferIcon = () =>
    row().querySelector<HTMLElement>("[data-git-transfer]");
  const syncingIcon = () =>
    row().querySelector(`[aria-label="${m.git_status_syncing()}"]`);
  const noAccessIcon = () => row().querySelector(".lucide-cloud-off");
  const missingIcon = () =>
    row().querySelector<HTMLElement>("[data-lfs-missing]");
  const unsentIcon = () =>
    row().querySelector<HTMLElement>("[data-lfs-unsent]");
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
      expect(doc.body.textContent).not.toContain(m.storage_lfs_downloading());
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
  test("files left without content take the LFS place last, as a calm icon with count, size and cause", async () => {
    mockStatus();
    const git = useGitStore.getState();
    const previousLocale = getLocale();
    const missing: LfsMissing = {
      files: [
        { path: "photos/a.jpg", size: 104_858 },
        { path: "photos/b.jpg", size: 419_430 },
        { path: "clips/video.mov", size: 125_304_832 },
      ],
      bytes: 125_829_120,
      stop: { kind: "unreachable" },
    };
    try {
      await setLocale("ru", { reload: false });
      git.updateBackendSyncing(SPACE, true);

      await render("ready", missing);
      const icon = missingIcon()!;
      expect(icon.getAttribute("role")).toBe("img");
      expect(icon.getAttribute("aria-label")).toBe(
        "Не скачано 3 файла · 120 МБ. Сервер недоступен.",
      );
      expect(!!icon.querySelector(".lucide-cloud-download")).toBe(true);
      expect(icon.outerHTML.includes("animate-")).toBe(false);
      expect(icon.querySelector("svg")!.classList).toContain(
        "text-muted-foreground",
      );
      expect(icon.outerHTML.includes("destructive")).toBe(false);
      const gitIndicator = syncingIcon()!.closest("span.size-4")!.outerHTML;
      expect(
        icon.compareDocumentPosition(syncingIcon()!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // A running transfer takes the place, then gives it back.
      await act(async () =>
        git.setTransfer(SPACE, {
          direction: "download",
          file: 3,
          files: 3,
          path: "clips/video.mov",
          bytes: 1_048_576,
          size: 125_304_832,
        }),
      );
      expect(missingIcon()).toBe(null);
      expect(transferIcon()?.dataset.gitTransfer).toBe("download");
      expect(syncingIcon()!.closest("span.size-4")!.outerHTML).toBe(
        gitIndicator,
      );
      await act(async () => git.setTransfer(SPACE, null));
      expect(!!missingIcon()).toBe(true);

      // No access comes before files left; a download or nothing missing shows none.
      await render("missing-creds", missing);
      expect(!!noAccessIcon()).toBe(true);
      expect(missingIcon()).toBe(null);
      await render("pulling", missing);
      expect(missingIcon()).toBe(null);
      expect(noAccessIcon()).toBe(null);
      await render("ready", null);
      expect(missingIcon()).toBe(null);
      expect(row().querySelector('[role="img"]')).toBe(null);

      await render("ready", { ...missing, stop: { kind: "stalled" } });
      expect(missingIcon()!.getAttribute("aria-label")).toBe(
        "Не скачано 3 файла · 120 МБ. 2 минуты не было передачи данных.",
      );
    } finally {
      await dom.render(null);
      git.setTransfer(SPACE, null);
      git.clear(SPACE);
      clearNativeMocks();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("files not sent take the LFS place after no access and before files not downloaded, as a calm icon with count, size and cause", async () => {
    mockStatus();
    const git = useGitStore.getState();
    const previousLocale = getLocale();
    const unsent: LfsUnsent = {
      files: [
        { path: "clips/recording.mov", size: 31_457_280 },
        { path: "photos/b.jpg", size: 10_485_760 },
      ],
      bytes: 41_943_040,
      stop: { kind: "unreachable" },
    };
    const missing: LfsMissing = {
      files: [{ path: "photos/a.jpg", size: 104_858 }],
      bytes: 104_858,
      stop: { kind: "not-on-server" },
    };
    try {
      await setLocale("ru", { reload: false });
      git.updateBackendSyncing(SPACE, true);

      await render("ready", missing, unsent);
      const icon = unsentIcon()!;
      expect(missingIcon()).toBe(null);
      expect(icon.getAttribute("role")).toBe("img");
      expect(icon.getAttribute("aria-label")).toBe(
        "Не отправлено 2 файла · 40 МБ. Сервер файлов недоступен — изменения опубликованы, файлы отправятся при следующей синхронизации.",
      );
      expect(!!icon.querySelector(".lucide-cloud-upload")).toBe(true);
      expect(icon.outerHTML.includes("animate-")).toBe(false);
      expect(icon.outerHTML.includes("destructive")).toBe(false);
      expect(icon.querySelector("svg")!.classList).toContain(
        "text-muted-foreground",
      );
      const gitIndicator = syncingIcon()!.closest("span.size-4")!.outerHTML;

      // A running transfer, the send of the queue, takes the place.
      await act(async () =>
        git.setTransfer(SPACE, {
          direction: "upload",
          file: 1,
          files: 2,
          path: "clips/recording.mov",
          bytes: 1_048_576,
          size: 31_457_280,
        }),
      );
      expect(unsentIcon()).toBe(null);
      expect(transferIcon()?.dataset.gitTransfer).toBe("upload");
      expect(syncingIcon()!.closest("span.size-4")!.outerHTML).toBe(
        gitIndicator,
      );
      await act(async () => git.setTransfer(SPACE, null));

      // No access comes first, with its own icon.
      await render("missing-creds", missing, {
        ...unsent,
        stop: { kind: "no-access" },
      });
      expect(!!noAccessIcon()).toBe(true);
      expect(unsentIcon()).toBe(null);

      await render("ready", null, { ...unsent, stop: { kind: "no-access" } });
      expect(unsentIcon()!.getAttribute("aria-label")).toBe(
        "Не отправлено 2 файла · 40 МБ. Нет доступа к серверу файлов — изменения опубликованы, файлы сохранены на устройстве.",
      );
      await render("ready", null, {
        ...unsent,
        stop: {
          kind: "stalled",
          path: "clips/recording.mov",
          size: 31_457_280,
        },
      });
      expect(unsentIcon()!.getAttribute("aria-label")).toBe(
        "Не отправлено 2 файла · 40 МБ. Отправка файла «recording.mov» (30 МБ) остановлена: 2 минуты не было передачи данных — изменения опубликованы, файлы отправятся при следующей синхронизации.",
      );

      // Sent: the files not downloaded show again.
      await render("ready", missing, null);
      expect(unsentIcon()).toBe(null);
      expect(!!missingIcon()).toBe(true);
    } finally {
      await dom.render(null);
      git.setTransfer(SPACE, null);
      git.clear(SPACE);
      clearNativeMocks();
      await setLocale(previousLocale, { reload: false });
    }
  });
}
