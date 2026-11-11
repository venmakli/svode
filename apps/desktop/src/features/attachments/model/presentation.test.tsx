import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyCollectionQuery } from "@/features/collection";
import { AttachmentIcon } from "../ui/attachment-icon";
import { attachmentKindLabel } from "./presentation";
import { getDirectoryPresentationKind } from "@/features/artifact";
import * as m from "@/paraglide/messages.js";

import { resolveStandardPropertyColumn } from "@/features/properties";
import {
  createRegisteredSpaceOwner,
  createPageOwner,
} from "@/features/scope-surfaces";

import {
  attachmentOwnerFromScopeOwner,
  attachmentOwnerInput,
  type AttachmentItem,
} from "./types";
import { createAttachmentsPresentationDescriptor } from "./presentation";
import { createAttachmentsCreateCapability } from "./create";

const page: AttachmentItem = {
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

test("App presentation unifies query values and sidebar facts without changing identity", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    onActivate: () => undefined,
  });
  const matrix = [
    ["page", false, "page", m.attachments_type_page()],
    ["page", true, "app", m.attachments_type_app()],
    ["collection", false, "collection", m.attachments_type_collection()],
    ["collection", true, "collection", m.attachments_type_collection()],
    ["app", true, "app", m.attachments_type_app()],
    ["directory", false, "directory", m.attachments_type_folder()],
  ] as const;
  const items = matrix.map(
    ([kind, hasApp], i): AttachmentItem => ({
      ...page,
      kind,
      hasApp,
      key: `${kind}:${i}`,
      path: String(i),
    }),
  );
  const original = structuredClone(items);
  for (const [i, [kind, hasApp, presentationKind, label]] of matrix.entries()) {
    const item = items[i]!;
    expect(
      getDirectoryPresentationKind({
        hasSchema: kind === "collection",
        hasApp,
        hasPage: kind === "page",
      }),
    ).toBe(presentationKind);
    expect(attachmentKindLabel(item)).toBe(label);
    expect(descriptor.getItemId(item)).toBe(item.key);
    const matching = items.filter((_, index) => matrix[index]![3] === label);
    for (const query of [
      { search: label, filters: [], sort: [] },
      {
        search: "",
        filters: [{ propertyKey: "type", operator: "eq", value: label }],
        sort: [],
      },
    ]) {
      expect(applyCollectionQuery({ descriptor, items, query }).items).toEqual(
        matching,
      );
    }
  }
  const ascending = [
    items[0],
    items[2],
    items[3],
    items[1],
    items[4],
    items[5],
  ];
  expect(
    applyCollectionQuery({
      descriptor,
      items: [...items].reverse(),
      query: {
        search: "",
        filters: [],
        sort: [{ propertyKey: "type", direction: "asc" }],
      },
    }).items,
  ).toEqual(ascending);
  const pageApp = items[1]!;
  expect(attachmentKindLabel({ ...pageApp, hasApp: false })).toBe(
    m.attachments_type_page(),
  );
  expect(items).toEqual(original);
});

test("fixed Attachments Table is Property-driven and query-capable", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: () => undefined,
  });

  expect(descriptor.id).toBe("all");
  expect(descriptor.layout).toEqual({
    density: "compact",
    kind: "table",
    primaryProperty: "title",
    visibleProperties: ["title", "type", "updated", "size"],
  });
  expect(descriptor.create).toBe(create);
  expect(
    descriptor.properties.map((property) => [
      property.common ?? null,
      property.label,
    ]),
  ).toEqual([
    ["title", "Name"],
    [null, "Type"],
    ["updated", "Modified"],
    [null, "Size"],
  ]);
  expect(descriptor.itemActions).toBe(undefined);
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
  expect(columns[0]).toEqual({ name: "title", type: "text" });
  expect(columns[1]?.name).toBe("type");
  expect(columns[1]?.type).toBe("select");
  expect(columns[2]).toEqual({
    display: "medium",
    name: "updated",
    type: "date",
  });
  expect(columns[3]).toEqual({
    display: "bytes",
    name: "size",
    type: "number",
  });
  expect(descriptor.query.defaultSort).toEqual([
    { direction: "asc", propertyKey: "title" },
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
  let activated: AttachmentItem | null = null;
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: (item) => {
      activated = item;
    },
  });

  await descriptor.onActivate?.(page, { itemId: page.key });

  expect<AttachmentItem | null>(activated).toEqual(page);
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

test("mixed item types use standard filter and size applicability with stable icons", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    create,
    onActivate: () => undefined,
  });
  const items: AttachmentItem[] = [
    "page",
    "collection",
    "app",
    "directory",
    "document",
    "media",
  ].map((kind, i) => ({
    ...page,
    kind: kind as AttachmentItem["kind"],
    key: String(i),
    path: String(i),
  }));
  for (const item of items) {
    const result = applyCollectionQuery({
      descriptor,
      items,
      query: {
        search: "",
        filters: [
          {
            propertyKey: "type",
            operator: "eq",
            value: attachmentKindLabel(item),
          },
        ],
        sort: [],
      },
    });
    expect(result.items.map((shown) => shown.kind)).toEqual([item.kind]);
    expect(descriptor.properties[3]?.getApplicability?.(item)?.status).toBe(
      item.kind === "document" || item.kind === "media"
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
        <AttachmentIcon item={{ ...page, kind, hasApp, format, icon }} />,
      );
      expect(markup.includes(`lucide-${fallback}`)).toBe(true);
      expect(markup.includes('aria-hidden="true"')).toBe(true);
    }
    const custom = renderToStaticMarkup(
      <AttachmentIcon item={{ ...page, kind, hasApp, format, icon: "🌱" }} />,
    );
    expect(custom.includes("🌱")).toBe(true);
    expect(custom.includes("<svg")).toBe(false);
  }
});

test("Attachments sort ties use content paths without changing typed item identity", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    onActivate: () => {},
  });
  const items = [
    { ...page, key: "page:a", path: "a" },
    { ...page, key: "app:z", path: "z", kind: "app" as const },
  ];
  const result = applyCollectionQuery({
    descriptor,
    items,
    query: { search: "", filters: [], sort: [] },
  });
  expect(result.items.map((item) => item.path)).toEqual(["a", "z"]);
});
