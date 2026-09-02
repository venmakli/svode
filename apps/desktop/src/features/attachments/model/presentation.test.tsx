import { expect, test } from "bun:test";

import { resolveStandardPropertyColumn } from "@/features/properties";
import { createRegisteredSpaceOwner } from "@/features/scope-surfaces";

import { isCurrentAttachmentsLoad } from "../hooks/use-attachments-source";
import { attachmentOwnerInput, type AttachmentRow } from "./types";
import { createAttachmentsPresentationDescriptor } from "./presentation";

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

test("fixed Attachments Table is Property-driven and query-capable", () => {
  const descriptor = createAttachmentsPresentationDescriptor({
    onActivate: () => undefined,
  });

  expect(descriptor.id).toBe("all");
  expect(descriptor.layout).toEqual({
    density: "compact",
    kind: "table",
    primaryProperty: "name",
    visibleProperties: ["name", "type", "modified", "size"],
  });
  expect(descriptor.create).toBe(undefined);
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

  expect(attachmentOwnerInput(root)).toEqual({
    projectPath: "/repo",
    spaceId: null,
  });
  expect(attachmentOwnerInput(child)).toEqual({
    projectPath: "/repo",
    spaceId: "child-id",
  });
});

test("stale owner and superseded requests cannot publish snapshots", () => {
  expect(isCurrentAttachmentsLoad("owner:a", "owner:a", 4, 4)).toBe(true);
  expect(isCurrentAttachmentsLoad("owner:b", "owner:a", 4, 4)).toBe(false);
  expect(isCurrentAttachmentsLoad("owner:a", "owner:a", 3, 4)).toBe(false);
});
