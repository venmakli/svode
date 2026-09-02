import { expect, test } from "bun:test";

import { resolveStandardPropertyColumn } from "@/features/properties";
import { createRegisteredSpaceOwner } from "@/features/scope-surfaces";

import { isCurrentAttachmentsLoad } from "../hooks/use-attachments-source";
import {
  attachmentOwnerFromScopeOwner,
  attachmentOwnerInput,
  type AttachmentRow,
} from "./types";
import { createAttachmentsPresentationDescriptor } from "./presentation";
import { createAttachmentsCreateCapability } from "./create";

const page: AttachmentRow = {
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
      label: "Import file…",
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

test("stale owner and superseded requests cannot publish snapshots", () => {
  expect(isCurrentAttachmentsLoad("owner:a", "owner:a", 4, 4)).toBe(true);
  expect(isCurrentAttachmentsLoad("owner:b", "owner:a", 4, 4)).toBe(false);
  expect(isCurrentAttachmentsLoad("owner:a", "owner:a", 3, 4)).toBe(false);
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
