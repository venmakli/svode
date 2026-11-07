import { expect, test } from "bun:test";

import {
  attachmentOpenFolderStep,
  reconcileAttachmentPeek,
} from "./activation";
import type { AttachmentBranch } from "./source-session";
import type {
  AttachmentActivationRequest,
  AttachmentItem,
  AttachmentsSnapshot,
} from "./types";

const owner = {
  projectPath: "/repo",
  spaceId: null,
  spacePath: "/repo",
  ownerPath: ".",
  repositoryPath: "/repo",
};

function item(
  path: string,
  kind: AttachmentItem["kind"],
  format = "",
): AttachmentItem {
  const directory =
    kind === "collection" || kind === "app" || kind === "directory";
  return {
    key: `${kind}:${path}`,
    path,
    kind,
    ownerPath: directory ? path : null,
    contentPath: kind === "page" ? path : null,
    sourcePath: path,
    sourceShape: directory ? "directory" : "file",
    hasApp: kind === "app",
    icon: null,
    format,
    availability: "available",
    displayName: path,
    modified: "",
    sizeBytes: null,
  };
}

function snapshot(
  items: AttachmentItem[],
  generation: string,
  spacePath = "/repo",
): AttachmentsSnapshot {
  return {
    owner: { ...owner, spacePath },
    generation,
    items,
    diagnostics: [],
  };
}

function peek(target: AttachmentItem): AttachmentActivationRequest {
  return {
    item: target,
    owner,
    mode: "peek",
    ownerSession:
      target.kind === "page" ||
      target.kind === "collection" ||
      target.kind === "app"
        ? { key: target.key, kind: target.kind }
        : undefined,
    sourceGeneration: "one",
    activation: { itemId: target.key },
  };
}

const html = item("reports/state.html", "document", "html");
const pdf = item("brief.pdf", "document", "pdf");
const image = item("photo.png", "media", "png");
const video = item("clip.mp4", "media", "mp4");
const other = item("other.md", "page");

test("a document or media peek outlives its file in the snapshot and takes the returned item", () => {
  for (const file of [html, pdf, image, video]) {
    const current = peek(file);
    expect(reconcileAttachmentPeek(current, snapshot([other], "missing"))).toBe(
      current,
    );

    const returned = { ...file, modified: "later", sizeBytes: 42 };
    expect(
      reconcileAttachmentPeek(current, snapshot([other, returned], "back")),
    ).toEqual({ ...current, item: returned, sourceGeneration: "back" });
  }
});

test("a page, collection, App or folder peek still closes when its item disappears", () => {
  for (const owned of [
    item("notes.md", "page"),
    item("tasks", "collection"),
    item("tool", "app"),
    item("assets", "directory"),
  ]) {
    expect(
      reconcileAttachmentPeek(peek(owned), snapshot([other], "missing")),
    ).toBe(null);
  }
});

test("another owner closes a document or media peek", () => {
  for (const file of [html, image]) {
    expect(
      reconcileAttachmentPeek(
        peek(file),
        snapshot([file], "other", "/repo/other"),
      ),
    ).toBe(null);
    expect(
      reconcileAttachmentPeek(peek(file), {
        ...snapshot([file], "nested"),
        owner: { ...owner, ownerPath: "nested" },
      }),
    ).toBe(null);
  }
});

test("a request to open a folder reads its ancestors and opens only an ordinary folder", () => {
  const reports = item("reports", "directory");
  const q3 = item("reports/q3", "directory");
  const tasks = item("tasks", "collection");
  const root = snapshot([reports, tasks, item("brief.pdf", "document")], "one");
  const none = new Map<string, AttachmentBranch>();
  const branch = (loading: boolean, error: string | null = null) =>
    new Map<string, AttachmentBranch>([
      ["reports", { target: reports, loading, error, request: 1 }],
    ]);

  expect(attachmentOpenFolderStep(root, none, "reports")).toEqual({
    kind: "open",
    item: reports,
  });
  expect(attachmentOpenFolderStep(root, none, "reports/q3")).toEqual({
    kind: "load",
    branchPath: "reports",
  });
  expect(attachmentOpenFolderStep(root, branch(true), "reports/q3")).toEqual({
    kind: "wait",
  });
  expect(
    attachmentOpenFolderStep(
      snapshot([...root.items, q3], "two"),
      branch(false),
      "reports/q3",
    ),
  ).toEqual({ kind: "open", item: q3 });
  for (const missing of [
    attachmentOpenFolderStep(root, branch(false), "reports/q3"),
    attachmentOpenFolderStep(root, branch(false, "gone"), "reports/q3"),
    attachmentOpenFolderStep(root, none, "gone"),
    attachmentOpenFolderStep(root, none, "report"),
    // Other kinds of items do not open on request.
    attachmentOpenFolderStep(root, none, "tasks"),
  ])
    expect(missing).toEqual({ kind: "missing" });
});
