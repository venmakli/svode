import { expect, test } from "bun:test";

import {
  filesToFileList,
  managedSourceFile,
  managedSourcePathForFile,
} from "./native-file-picker";

test("managed picker metadata preserves native source identity without bytes", () => {
  const file = managedSourceFile("/tmp/large-video.mp4", {
    mime: "video/mp4",
    name: "large-video.mp4",
    sizeBytes: 512 * 1024 * 1024,
  });
  const list = filesToFileList([file]);

  expect(file.name).toBe("large-video.mp4");
  expect(file.size).toBe(512 * 1024 * 1024);
  expect(managedSourcePathForFile(list.item(0)!)).toBe("/tmp/large-video.mp4");
  expect(Array.from(list)).toEqual([file]);
});
