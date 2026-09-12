import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyCollectionQuery } from "@/features/collection";
import { AttachmentIcon } from "../ui/attachment-icon";
import { attachmentKindLabel } from "./presentation";

import { resolveStandardPropertyColumn } from "@/features/properties";
import {
  createRegisteredSpaceOwner,
  createPageOwner,
} from "@/features/scope-surfaces";

import {
  attachmentOwnerFromScopeOwner,
  attachmentOwnerInput,
  type AttachmentRow,
} from "./types";
import { createAttachmentsPresentationDescriptor } from "./presentation";
import { createAttachmentsCreateCapability } from "./create";

const page: AttachmentRow = {
  contentPath: "roadmap.md",
  sourcePath: "roadmap.md",
  ownerPath: null,
  icon: null,
  hasApp: false,
  availability: "available",
  displayName: "Roadmap",
  format: "markdown",
  key: "page:roadmap.md",
  kind: "page",
  modified: "2026-09-01T08:00:00Z",
  path: "roadmap.md",
  sizeBytes: null,
  sourceShape: "file",
};

const create = {
  intents: [
    {
      getState: () => ({ status: "idle" as const }),
      id: "import-file",
      label: "Add file…",
      run: () => undefined,
    },
  ],
  label: "Add",
};

test("fixed Attachments Table is Property-driven and query-capable", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: () => undefined,
  });

  expect(descriptor.id).toBe("all");
  expect(descriptor.layout).toEqual({
    density: "compact",
    kind: "table",
    primaryProperty: "name",
    visibleProperties: ["name", "type", "modified", "size"],
  });
  expect(descriptor.create).toBe(create);
  expect(descriptor.rowActions).toBe(undefined);
  expect(descriptor.properties.map((property) => property.origin)).toEqual([
    "computed",
    "computed",
    "computed",
    "computed",
  ]);
  expect(
    descriptor.properties.map((property) => property.capabilities?.filter),
  ).toEqual([
    { kind: "standard" },
    { kind: "standard" },
    { kind: "standard" },
    { kind: "standard" },
  ]);
  expect(
    descriptor.properties.map((property) => property.capabilities?.sort),
  ).toEqual([
    { kind: "standard" },
    { kind: "standard" },
    { kind: "standard" },
    { kind: "standard" },
  ]);
  const columns = descriptor.properties.map((property) =>
    resolveStandardPropertyColumn(property),
  );
  expect(columns[0]).toEqual({ name: "name", type: "text" });
  expect(columns[1]?.name).toBe("type");
  expect(columns[1]?.type).toBe("select");
  expect(columns[2]).toEqual({
    display: "medium",
    name: "modified",
    type: "date",
  });
  expect(columns[3]).toEqual({
    display: "bytes",
    name: "size",
    type: "number",
  });
  expect(descriptor.query.defaultSort).toEqual([
    { direction: "asc", propertyKey: "name" },
  ]);
  expect(descriptor.query.getSearchText?.(page)?.includes("Roadmap")).toBe(
    true,
  );
  expect(descriptor.properties[3]?.getApplicability?.(page)).toEqual({
    label: "—",
    status: "unavailable",
  });
});

test("activation remains an opaque owner callback", async () => {
  let activated: AttachmentRow | null = null;
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: (row) => {
      activated = row;
    },
  });

  await descriptor.onActivate?.(page, { rowId: page.key });

  expect(activated).toEqual(page);
});

test("registered owner input distinguishes Project root from child Space", () => {
  const root = createRegisteredSpaceOwner({
    hasSchema: false,
    projectPath: "/repo",
    spaceId: "project-id",
    spacePath: "/repo",
    status: "ready",
  });
  const child = createRegisteredSpaceOwner({
    hasSchema: false,
    projectPath: "/repo",
    spaceId: "child-id",
    spacePath: "/repo/child",
    status: "ready",
  });

  expect(attachmentOwnerInput(attachmentOwnerFromScopeOwner(root))).toEqual({
    ownerPath: ".",
    projectPath: "/repo",
    spaceId: null,
  });
  expect(attachmentOwnerInput(attachmentOwnerFromScopeOwner(child))).toEqual({
    ownerPath: ".",
    projectPath: "/repo",
    spaceId: "child-id",
  });
});

test("Attachments create intents follow direct Collection ownership", () => {
  const standaloneOwner = createAttachmentsCreateCapability({
    hasDirectCollection: false,
    onCreatePage: () => undefined,
    onImportFile: () => undefined,
    state: { status: "idle" },
  });
  const collectionOwner = createAttachmentsCreateCapability({
    hasDirectCollection: true,
    onCreatePage: () => undefined,
    onImportFile: () => undefined,
    state: { reason: "Read-only", status: "disabled" },
  });

  expect(standaloneOwner.intents.map((intent) => intent.id)).toEqual([
    "new-page",
    "import-file",
  ]);
  expect(collectionOwner.intents.map((intent) => intent.id)).toEqual([
    "import-file",
  ]);
  expect(collectionOwner.intents[0]?.getState()).toEqual({
    reason: "Read-only",
    status: "disabled",
  });
});

test("Page owner mapping preserves root and child source normalization", () => {
  for (const spacePath of ["/repo", "/repo/child"]) {
    const owner = createPageOwner({
      spaceId: "page-space",
      spacePath,
      projectPath: "/repo",
      status: "ready",
      form: "folder",
      contentPath: "Notes/README.md",
      ownerPath: "Notes",
      hasApp: true,
    });
    const mapped = attachmentOwnerFromScopeOwner(owner);
    expect(attachmentOwnerInput(mapped)).toEqual({
      projectPath: "/repo",
      spaceId: spacePath === "/repo" ? null : "page-space",
      ownerPath: "Notes",
    });
    expect(mapped.hasDirectCollection).toBe(false);
    expect(mapped.contentPath).toBe("Notes/README.md");
  }
});

test("mixed row types use standard filter and size applicability with stable icons", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: () => undefined,
  });
  const rows: AttachmentRow[] = [
    "page",
    "collection",
    "app",
    "directory",
    "document",
    "media",
  ].map((kind, i) => ({
    ...page,
    kind: kind as AttachmentRow["kind"],
    key: String(i),
    path: String(i),
  }));
  for (const row of rows) {
    const result = applyCollectionQuery({
      descriptor,
      rows,
      query: {
        search: "",
        filters: [
          {
            propertyKey: "type",
            operator: "eq",
            value: attachmentKindLabel(row.kind),
          },
        ],
        sort: [],
      },
    });
    expect(result.rows.map((item) => item.kind)).toEqual([row.kind]);
    expect(descriptor.properties[3]?.getApplicability?.(row)?.status).toBe(
      row.kind === "document" || row.kind === "media"
        ? "applicable"
        : "unavailable",
    );
  }
  for (const [kind, hasApp, format, fallback] of [
    ["page", false, "markdown", "file-text"],
    ["page", true, "markdown", "panels-top-left"],
    ["collection", true, "markdown", "database"],
    ["app", true, "", "panels-top-left"],
    ["directory", false, "", "folder-open"],
    ["document", false, "pdf", "file-text"],
    ["media", false, "png", "file-image"],
    ["media", false, "mp3", "music"],
    ["media", false, "mp4", "video"],
    ["media", false, "unknown", "file"],
  ] as const) {
    for (const icon of [null, "", "  ", "\u0001"]) {
      const markup = renderToStaticMarkup(
        <AttachmentIcon row={{ ...page, kind, hasApp, format, icon }} />,
      );
      expect(markup.includes(`lucide-${fallback}`)).toBe(true);
      expect(markup.includes('aria-hidden="true"')).toBe(true);
    }
    const custom = renderToStaticMarkup(
      <AttachmentIcon row={{ ...page, kind, hasApp, format, icon: "🌱" }} />,
    );
    expect(custom.includes("🌱")).toBe(true);
    expect(custom.includes("<svg")).toBe(false);
  }
});

test("Attachments sort ties use content paths without changing typed row identity", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    onActivate: () => {},
  });
  const rows = [
    { ...page, key: "page:a", path: "a" },
    { ...page, key: "app:z", path: "z", kind: "app" as const },
  ];
  const result = applyCollectionQuery({
    descriptor,
    rows,
    query: { search: "", filters: [], sort: [] },
  });
  expect(result.rows.map((row) => row.path)).toEqual(["a", "z"]);
});
