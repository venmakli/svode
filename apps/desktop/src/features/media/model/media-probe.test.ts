import { expect, test } from "bun:test";

import { probeMediaTarget } from "./media-probe";

test("media probe claims image and playback candidates", () => {
  for (const path of [
    "photo.PNG",
    "motion.gif",
    "safe.svg",
    "audio.mp3",
    "movie.MOV",
    "future.avif",
  ]) {
    const result = probeMediaTarget({
      path,
      sourceShape: "file",
      spaceId: "space",
    });
    expect(result.status).toBe("match");
    if (result.status === "match") expect(result.identity.kind).toBe("media");
  }
});

test("media probe does not claim directories or unknown files", () => {
  expect(
    probeMediaTarget({
      path: "folder/README.md",
      sourceShape: "directory",
      spaceId: "space",
    }),
  ).toEqual({ status: "no_match" });
  expect(
    probeMediaTarget({
      path: "archive.zip",
      sourceShape: "file",
      spaceId: "space",
    }),
  ).toEqual({ status: "no_match" });
});
