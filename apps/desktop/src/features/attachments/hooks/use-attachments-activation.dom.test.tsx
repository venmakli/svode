import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  closeActiveContent,
  getActiveContentSelection,
} from "@/features/artifact";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { AttachmentsSnapshotDto } from "@/platform/attachments/attachments-api";
import type { AttachmentOwnerRef, AttachmentRow } from "../model/types";
import { useAttachmentsActivation } from "./use-attachments-activation";

test("typed activation and source refresh reject stale owner, marker and request results", async () => {
  const dom = new JSDOM("<div id='app'></div>", { url: "http://localhost/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const pending: Array<(snapshot: AttachmentsSnapshotDto) => void> = [];
  mockNativeIpc((command) =>
    command === "attachments_list"
      ? new Promise<AttachmentsSnapshotDto>((resolve) => pending.push(resolve))
      : 1,
  );
  const owner: AttachmentOwnerRef = {
    ownerKey: "root",
    identityKind: "registered-space",
    projectPath: "/repo",
    spaceId: "root",
    spacePath: "/repo",
    ownerPath: ".",
    contentPath: "README.md",
    hasDirectCollection: false,
  };
  const page: AttachmentRow = {
    key: "page:notes.md",
    path: "notes.md",
    contentPath: "notes.md",
    ownerPath: null,
    sourcePath: "notes.md",
    sourceShape: "file",
    kind: "page",
    hasApp: false,
    icon: null,
    displayName: "Notes",
    modified: "2026-09-12T00:00:00Z",
    sizeBytes: null,
    format: "markdown",
    availability: "available",
  };
  const collection: AttachmentRow = {
    ...page,
    key: "collection:tasks",
    path: "tasks",
    kind: "collection",
    ownerPath: "tasks",
    contentPath: null,
    sourcePath: "tasks/schema.yaml",
    sourceShape: "directory",
  };
  const app: AttachmentRow = {
    ...collection,
    key: "app:tool",
    path: "tool",
    kind: "app",
    ownerPath: "tool",
    sourcePath: "tool/app.yaml",
    hasApp: true,
  };
  function snapshot(
    generation: string,
    items = [page, collection, app],
    spacePath = "/repo",
  ): AttachmentsSnapshotDto {
    return {
      owner: {
        projectPath: "/repo",
        spacePath,
        spaceId: null,
        ownerPath: ".",
        repositoryPath: "/repo",
      },
      generation,
      items,
      diagnostics: [],
    };
  }
  let current!: ReturnType<typeof useAttachmentsActivation>;
  function Harness({ target }: { target: AttachmentOwnerRef }) {
    const value = useAttachmentsActivation(target);
    useEffect(() => {
      current = value;
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  try {
    await act(async () => root.render(<Harness target={owner} />));
    await act(async () => pending.shift()!(snapshot("one")));
    for (const row of [
      page,
      {
        ...page,
        kind: "document" as const,
        key: "document:brief.pdf",
        path: "brief.pdf",
      },
      {
        ...page,
        kind: "media" as const,
        key: "media:photo.png",
        path: "photo.png",
      },
    ]) {
      let refresh!: Promise<void>;
      await act(async () => {
        refresh = current.source.refresh();
      });
      await act(async () => {
        pending.shift()!(snapshot(row.key, [row, collection, app]));
        await refresh;
      });
      await act(async () => current.onActivate(row, { rowId: row.key }));
      expect(current.peekTarget?.row.kind).toBe(row.kind);
      await act(async () => current.closePeek());
    }
    for (const row of [collection, app]) {
      await act(async () => current.onActivate(row, { rowId: row.key }));
      expect(getActiveContentSelection().selection).toBe(null);
      expect(current.peekTarget?.row).toEqual(row);
      await act(async () => current.closePeek());
    }
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = current.source.refresh();
      second = current.source.refresh();
    });
    const old = pending.shift()!;
    const newer = pending.shift()!;
    await act(async () => {
      newer(snapshot("newer", [page]));
      await second;
    });
    await act(async () => {
      old(snapshot("older"));
      await first;
    });
    assert.throws(() => current.onActivate(app, { rowId: app.key }));
    await act(async () => current.onActivate(page, { rowId: page.key }));
    await act(async () => {
      first = current.source.refresh();
    });
    await act(async () => {
      pending.shift()!(snapshot("changed", [{ ...page, kind: "collection" }]));
      await first;
    });
    expect(current.peekTarget).toBe(null);
    assert.throws(() => current.onActivate(page, { rowId: page.key }));
    await act(async () => {
      first = current.source.refresh();
    });
    const previousOwner = pending.shift()!;
    await act(async () =>
      root.render(
        <Harness
          target={{
            ...owner,
            ownerKey: "other",
            spaceId: "other",
            spacePath: "/repo/other",
          }}
        />,
      ),
    );
    await act(async () => {
      previousOwner(snapshot("late"));
      await first;
    });
    expect(current.source.state.phase).toBe("initial");
    await act(async () =>
      pending.shift()!(snapshot("other", [], "/repo/other")),
    );
    expect(current.source.state.phase).toBe("ready");
  } finally {
    await act(async () => root.unmount());
    closeActiveContent();
    clearNativeMocks();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
