import { expect, test } from "bun:test";
import type { GitPublicationSpaceClass } from "@/platform/git/publication-errors";
import * as m from "@/paraglide/messages.js";
import {
  publicationBlockCopy,
  publicationBlockedSpaces,
  publicationBlockSpacePaths,
  type GitPublicationBlock,
} from "./publication-block";

const block: GitPublicationBlock = {
  project: "/project",
  spaces: [
    { path: "compliance", class: "local_commits" },
    { path: "legal", class: "local_commits" },
    { path: "spaces/ops", class: "missing" },
    { path: "archive", class: "local_commits" },
  ],
};
const context = {
  projectPath: "/project",
  spaces: [
    { name: "Compliance", path: "/project/compliance" },
    { name: "Legal", path: "/project/legal/" },
    { name: "Operations", path: "/project/spaces/ops" },
  ],
};

test("blocked Spaces are named by the project's Spaces and by path otherwise", () => {
  expect(publicationBlockSpacePaths(block, context)).toEqual([
    "/project/compliance",
    "/project/legal/",
    "/project/spaces/ops",
    "/project/archive",
  ]);
  const spaces = publicationBlockedSpaces(block, context, new Set());
  expect(spaces.map(({ name, namedByPath }) => [name, namedByPath])).toEqual([
    ["Compliance", false],
    ["Legal", false],
    ["Operations", false],
    ["archive", true],
  ]);
});

test("local commits are publishable unless the Space is confirmed read-only", () => {
  const spaces = publicationBlockedSpaces(
    block,
    context,
    new Set(["/project/legal/", "/project/spaces/ops"]),
  );
  expect(
    spaces.map(({ path, readOnly, publishable }) => [
      path,
      readOnly,
      publishable,
    ]),
  ).toEqual([
    ["compliance", false, true],
    ["legal", true, false],
    ["spaces/ops", true, false],
    ["archive", false, true],
  ]);
});

test("Windows separators and the open project path still find the Space", () => {
  const windows = publicationBlockedSpaces(
    { project: "C:\\project", spaces: [block.spaces[0]] },
    {
      projectPath: null,
      spaces: [{ name: "Compliance", path: "C:\\project\\compliance" }],
    },
    new Set(),
  );
  expect(windows[0].name).toBe("Compliance");
  // The refusal may carry the canonical project path the app opened by another one.
  const canonical = publicationBlockedSpaces(
    { project: "/private/project", spaces: [block.spaces[0]] },
    context,
    new Set(),
  );
  expect(canonical[0].spacePath).toBe("/project/compliance");
});

test("the block copy asks to publish while any Space version needs publishing", () => {
  const publish = {
    title: m.git_publication_block_title(),
    status: m.git_sync_publication_blocked_status(),
  };
  const verify = {
    title: m.git_publication_block_verify_failed_title(),
    status: m.git_sync_publication_verify_failed_status(),
  };
  const classes: [GitPublicationSpaceClass, typeof publish][] = [
    ["local_commits", publish],
    ["outside_branch", publish],
    ["missing", publish],
    ["unverified", verify],
    ["source_unavailable", verify],
    ["uninitialized", verify],
    ["configuration", verify],
  ];
  for (const [only, expected] of classes) {
    expect(publicationBlockCopy([{ class: only }])).toEqual(expected);
    // Any class that needs publishing names the publication.
    for (const [other, otherExpected] of classes)
      expect(publicationBlockCopy([{ class: other }, { class: only }])).toEqual(
        expected === publish || otherExpected === publish ? publish : verify,
      );
  }
  expect(publicationBlockCopy([])).toEqual(publish);
});
