import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import type { GitTransfer } from "../model";
import { gitTransferLabel, gitTransferPercent } from "./git-transfer-copy";

const upload: GitTransfer = {
  direction: "upload",
  file: 1,
  files: 2,
  path: "media/clips/video.mov",
  bytes: 12_582_912,
  size: 99_614_720,
};
const download: GitTransfer = {
  direction: "download",
  file: 2,
  files: 6,
  path: "photos/photo.jpg",
  bytes: 314_573,
  size: 419_430,
};

test("a transfer reads as its direction, count, file name and megabytes", async () => {
  const original = getLocale();
  try {
    await setLocale("ru", { reload: false });
    expect(gitTransferLabel(upload)).toBe(
      "Отправка 1 из 2 · video.mov · 12 из 95 МБ",
    );
    expect(gitTransferLabel(download)).toBe(
      "Скачивание 2 из 6 · photo.jpg · 0,3 из 0,4 МБ",
    );
    await setLocale("en", { reload: false });
    expect(gitTransferLabel(upload)).toBe(
      "Uploading 1 of 2 · video.mov · 12 of 95 MB",
    );
    expect(gitTransferLabel(download)).toBe(
      "Downloading 2 of 6 · photo.jpg · 0.3 of 0.4 MB",
    );
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("an unknown file count or size leaves its part out", async () => {
  const original = getLocale();
  try {
    await setLocale("ru", { reload: false });
    expect(gitTransferLabel({ ...upload, files: 0 })).toBe(
      "Отправка · video.mov · 12 из 95 МБ",
    );
    expect(gitTransferLabel({ ...download, size: 0 })).toBe(
      "Скачивание 2 из 6 · photo.jpg",
    );
    expect(gitTransferLabel({ ...upload, path: "video.mov" })).toBe(
      "Отправка 1 из 2 · video.mov · 12 из 95 МБ",
    );
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("the progress of the current file is its share, unknown without a size", () => {
  expect(gitTransferPercent({ ...upload, bytes: 0 })).toBe(0);
  expect(gitTransferPercent({ ...upload, bytes: upload.size / 4 })).toBe(25);
  expect(gitTransferPercent({ ...upload, size: 0 })).toBe(null);
});
