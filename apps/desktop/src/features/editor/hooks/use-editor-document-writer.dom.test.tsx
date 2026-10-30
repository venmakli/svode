import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type Descendant, type TElement } from "platejs";
import { createPlateEditor, type PlateEditor } from "platejs/react";
import type { Page, PageSourceConflict } from "@/features/page";
import {
  refreshGitSpaceStatus,
  registerPageSaveOwner,
  type GitCommitRefusal,
  type GitSaveScope,
} from "@/features/git/editor";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";
import type { ConflictElement } from "../conflict/parse-conflicts";
import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import { useEditorStore } from "../model";
import { EditorKit } from "../plate/editor-kit";
import { useEditorDocumentWriter } from "./use-editor-document-writer";

const SPACE = "/space";

interface WriteCall {
  content: string;
  sourceVersion: string;
}

function page(path: string, body: string, version: string): Page {
  return {
    path,
    body,
    source_version: version,
    meta: { title: "Plan", icon: null, created: "", updated: "", extra: {} },
  };
}

async function harness(path: string, body: string, markerSize = 7) {
  const dom = await createTestDom();
  const disk = { body, version: "v1", readFails: false, dirty: false };
  const writes: WriteCall[] = [];
  const commits: { command: string; paths: string[] }[] = [];
  const versionChoices: string[] = [];
  const markerSizeReads: string[] = [];
  const conflicts: (PageSourceConflict | null)[] = [];
  let reads = 0;
  mockNativeIpc((command, args) => {
    const input = args as Record<string, string>;
    if (command === "read_page") {
      reads += 1;
      if (disk.readFails) throw new Error("Synthetic read failure");
      return page(path, disk.body, disk.version);
    }
    if (command.startsWith("git_commit_")) {
      commits.push({
        command,
        paths: (args as { filePaths?: string[]; filePath?: string })
          .filePaths ?? [input.filePath],
      });
      disk.dirty = false;
      return { files: [] };
    }
    if (command === "write_page_body") {
      if (input.sourceVersion !== disk.version) throw { kind: "source_stale" };
      writes.push({
        content: input.content,
        sourceVersion: input.sourceVersion,
      });
      // The core keeps the frontmatter bytes and writes the body as sent.
      disk.body = input.content;
      disk.version = `v${writes.length + 1}`;
      return { write_nonce: `n${writes.length}`, source_version: disk.version };
    }
    if (command === "git_status")
      return { files: disk.dirty ? [{ path, state: "modified" }] : [] };
    if (command === "git_conflict_marker_size") {
      markerSizeReads.push(input.path);
      return markerSize;
    }
    return null;
  });

  const editor = createPlateEditor({ plugins: EditorKit });
  const ref = <T,>(current: T) => ({ current });
  const debounceTimerRef = ref<ReturnType<typeof setTimeout> | null>(null);
  const writerRef = ref<ReturnType<typeof useEditorDocumentWriter> | null>(
    null,
  );
  const noop = () => {};
  const refs = {
    bufferTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    currentCacheKeyRef: ref<string | null>(`${SPACE}\0${path}`),
    currentPathRef: ref<string | null>(path),
    descriptionRef: ref(""),
    iconRef: ref<string | null>(null),
    isDebouncePendingRef: ref(false),
    isLoadingRef: ref(false),
    ownNoncesRef: ref(new Set<string>()),
    titleRef: ref("Plan"),
  };

  function Writer() {
    const writer = useEditorDocumentWriter({
      ...refs,
      activeWsId: null,
      cancelDebounce: () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      },
      clearUnsaved: noop,
      currentDocument: path,
      debounceTimerRef,
      editor,
      loadEditorValue: (value: Descendant[]) =>
        loadProgrammaticEditorValue(editor, value),
      onSourcePageLoaded: noop,
      onSourceMetadata: noop,
      onSourceConflict: (conflict) => conflicts.push(conflict),
      patchPageTreeMeta: noop,
      projectPath: null,
      saveScopeTree: [],
      spacePath: SPACE,
      readOnly: false,
    });
    useEffect(() => {
      writerRef.current = writer;
    });
    const { handleSave, handleSaveAll, hasSourceConflict } = writer;
    // The owner the Page session registers for the commits of this window.
    useEffect(
      () =>
        registerPageSaveOwner(SPACE, path, {
          save: handleSave,
          saveAll: handleSaveAll,
          sourceConflict: () =>
            hasSourceConflict()
              ? {
                  title: "Plan",
                  chooseVersion: () => versionChoices.push(path),
                }
              : null,
        }),
      [handleSave, handleSaveAll, hasSourceConflict],
    );
    return null;
  }

  await dom.render(<Writer />);
  // Loads the source the way discarding a draft does: editor value and baseline.
  await act(() => writerRef.current!.discardPendingSource());

  const commit = async (
    run: (
      writer: ReturnType<typeof useEditorDocumentWriter>,
    ) => Promise<GitCommitRefusal | null>,
  ) => {
    let refusal: GitCommitRefusal | null = null;
    await act(async () => {
      refusal = await run(writerRef.current!);
    });
    return refusal as GitCommitRefusal | null;
  };

  return {
    editor,
    writes,
    commits,
    conflicts,
    versionChoices,
    disk,
    markerSizeReads,
    reads: () => reads,
    /** Marks the edited value as a draft whose autosave is not due yet. */
    holdDraft: () => {
      debounceTimerRef.current = setTimeout(noop, 60_000);
    },
    /** Saves the edited value as autosave does once its debounce is due. */
    save: async () => {
      debounceTimerRef.current = setTimeout(noop, 60_000);
      await act(() => writerRef.current!.flushPendingSource());
    },
    reconcile: () =>
      act(() => writerRef.current!.reconcileExternalChange(path)),
    /** ⌘S of the Page. */
    commitPage: () => commit((writer) => writer.handleSave()),
    /** ⇧⌘S of the Page, or the area commit "Changes" sends to its owner. */
    commitArea: (scope?: GitSaveScope) =>
      commit((writer) => writer.handleSaveAll(scope)),
    cleanup: async () => {
      clearNativeMocks();
      await dom.dispose();
    },
  };
}

function appendToBlock(editor: PlateEditor, text: string, suffix: string) {
  const index = editor.children.findIndex(
    (node) => NodeApi.string(node) === text,
  );
  expect(index === -1).toBe(false);
  editor.tf.insertText(suffix, { at: editor.api.end([index]) });
}

function serialized(editor: PlateEditor) {
  return editor.getApi(MarkdownPlugin).markdown.serialize();
}

const sources = [
  {
    name: "one LF blank line",
    body: "\nStatus: ok\n\nMiddle\n\nMore\n",
    leading: "\n",
  },
  {
    name: "two blank lines",
    body: "\n\nStatus: ok\n\nMiddle\n\nMore\n",
    leading: "\n\n",
  },
  {
    name: "CRLF blank line",
    body: "\r\nStatus: ok\r\n\r\nMiddle\r\n\r\nMore\r\n",
    leading: "\r\n",
  },
  {
    name: "blank lines holding spaces",
    body: "  \n\t\nStatus: ok\n\nMiddle\n\nMore\n",
    leading: "  \n\t\n",
  },
  {
    name: "no blank line",
    body: "Status: ok\n\nMiddle\n\nMore\n",
    leading: "",
  },
  {
    name: "Page without frontmatter starting with a blank line",
    body: "\n# Notes\n\nMiddle\n\nMore\n",
    leading: "\n",
  },
];

for (const source of sources) {
  test(`save keeps the leading blank lines of the body: ${source.name}`, async () => {
    const path = `pages/${source.name.replaceAll(" ", "-")}.md`;
    const view = await harness(path, source.body);
    try {
      appendToBlock(view.editor, "Middle", " edited");
      await view.save();
      expect(view.writes.length).toBe(1);
      const first = view.writes[0].content;
      expect(first.slice(0, source.leading.length)).toBe(source.leading);
      expect(first.slice(source.leading.length)).toBe(serialized(view.editor));
      expect(first.includes("Middle edited")).toBe(true);
      expect(/^[ \t]*\r?\n/.test(first.slice(source.leading.length))).toBe(
        false,
      );

      appendToBlock(view.editor, "More", " again");
      await view.save();
      expect(view.writes.length).toBe(2);
      expect(view.writes[1].sourceVersion).toBe("v2");
      expect(view.writes[1].content).toBe(
        source.leading + serialized(view.editor),
      );

      // The reread source is the written baseline: nothing to reconcile.
      const readsBefore = view.reads();
      await view.reconcile();
      expect(view.reads()).toBe(readsBefore + 1);
      expect(view.disk.version).toBe("v3");

      // A metadata change under the editor keeps the body: the stale write
      // rebases onto it instead of opening a conflict.
      view.disk.version = "v3-meta";
      appendToBlock(view.editor, "Middle edited", "!");
      await view.save();
      expect(view.writes.length).toBe(3);
      expect(view.writes[2].sourceVersion).toBe("v3-meta");
      expect(view.writes[2].content).toBe(
        source.leading + serialized(view.editor),
      );
      expect(view.conflicts.filter(Boolean)).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });
}

test("save of text typed into an empty body adds no blank line", async () => {
  const path = "pages/empty.md";
  const view = await harness(path, "");
  try {
    view.editor.tf.insertText("Typed", { at: view.editor.api.start([0]) });
    await view.save();
    expect(view.writes.map((write) => write.content)).toEqual(["Typed\n"]);
  } finally {
    await view.cleanup();
  }
});

test("a draft written over a changed source keeps the leading blank lines it was edited from", async () => {
  const path = "pages/conflict.md";
  const view = await harness(path, "\nStatus: ok\n\nMiddle\n");
  try {
    appendToBlock(view.editor, "Middle", " edited");
    view.holdDraft();
    view.disk.body = "Status: changed\n";
    view.disk.version = "v-external";
    await view.reconcile();
    const conflict = view.conflicts.at(-1);
    expect(conflict?.status).toBe("ready");

    await act(async () => {
      conflict!.writeDraft();
      for (let turn = 0; turn < 20 && view.writes.length === 0; turn++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.writes).toEqual([
      {
        content: "\n" + serialized(view.editor),
        sourceVersion: "v-external",
      },
    ]);
    expect(view.conflicts.at(-1)).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test("a reloaded CRLF source parses blocks with the marker size of its path and blocks the save until a side is chosen", async () => {
  const path = "pages/crlf-conflict.md";
  const view = await harness(path, "Plain\r\n\r\nText\r\n", 10);
  try {
    // A body without a line opening a block does not ask Git.
    expect(view.markerSizeReads).toEqual([]);

    view.disk.body = [
      "# Plan",
      "",
      "<<<<<<<<<< HEAD",
      "Status: local edit",
      "=======",
      "|||||||||| base",
      "Status: draft",
      "==========",
      "Status: remote edit",
      ">>>>>>>>>> other",
      "",
      "Footer",
      "",
    ].join("\r\n");
    view.disk.version = "v-merge";
    await view.reconcile();
    expect(view.markerSizeReads).toEqual([path]);
    const index = view.editor.children.findIndex(
      (node) => (node as TElement).type === "conflict",
    );
    const conflict = view.editor.children[index] as unknown as ConflictElement;
    expect([conflict.ours, conflict.theirs]).toEqual([
      "Status: local edit\r\n=======",
      "Status: remote edit",
    ]);

    await view.save();
    expect(view.writes).toEqual([]);

    // Accepting "theirs" the way the conflict block does.
    view.editor.tf.removeNodes({ at: [index] });
    view.editor.tf.insertNodes(
      deserializeEditorMarkdownInsertion(
        view.editor,
        conflict.theirs.trim() + "\n",
      ) as never,
      { at: [index] },
    );
    await view.save();
    expect(view.writes.map((write) => write.content)).toEqual([
      "# Plan\n\nStatus: remote edit\n\nFooter\n",
    ]);
  } finally {
    await view.cleanup();
  }
});

/** A draft of `path` whose source then changed outside Svode, reported as a conflict. */
async function openSourceConflict(
  path: string,
  status: "ready" | "read_failed" = "ready",
) {
  const view = await harness(path, "Plan\n\nMiddle\n");
  appendToBlock(view.editor, "Middle", " edited");
  useEditorStore.getState().markUnsaved(SPACE, path);
  view.holdDraft();
  view.disk.body = "Changed outside\n";
  view.disk.version = "v-external";
  view.disk.readFails = status === "read_failed";
  await view.reconcile();
  expect(view.conflicts.at(-1)?.status).toBe(status);
  // The external edit left the file changed in the working tree.
  view.disk.dirty = true;
  await act(() => refreshGitSpaceStatus(SPACE));
  return view;
}

async function untilResolved(view: Awaited<ReturnType<typeof harness>>) {
  await act(async () => {
    for (let turn = 0; turn < 40 && view.conflicts.at(-1) !== null; turn++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(view.conflicts.at(-1)).toBeNull();
}

for (const status of ["ready", "read_failed"] as const) {
  test(`an explicit commit during a ${status} source conflict writes and commits nothing and returns the refusal`, async () => {
    const path = `pages/refused-${status}.md`;
    const view = await openSourceConflict(path, status);
    try {
      const space = { kind: "space", path: "", label: "space" } as const;
      for (const refusal of [
        await view.commitPage(),
        await view.commitArea(),
        await view.commitArea(space),
      ]) {
        expect(refusal?.path).toBe(path);
        expect(refusal?.title).toBe("Plan");
      }
      expect(view.writes).toEqual([]);
      expect(view.commits).toEqual([]);
      // The surface of the entry presents the refusal, not the writer.
      expect(view.versionChoices).toEqual([]);
      (await view.commitPage())!.chooseVersion();
      expect(view.versionChoices).toEqual([path]);
    } finally {
      await view.cleanup();
    }
  });
}

test("after loading the file version the next explicit commit commits the file version", async () => {
  const path = "pages/refused-then-loaded.md";
  const view = await openSourceConflict(path);
  try {
    expect((await view.commitPage()) === null).toBe(false);
    await act(async () => view.conflicts.at(-1)!.loadFile());
    await untilResolved(view);
    useEditorStore.getState().clearUnsaved(SPACE, path);

    expect(await view.commitPage()).toBeNull();
    expect(view.writes.map((write) => write.content)).toEqual([
      "Changed outside\n",
    ]);
    expect(view.commits).toEqual([
      { command: "git_commit_file", paths: [path] },
    ]);

    view.disk.dirty = true;
    expect(await view.commitArea()).toBeNull();
    expect(view.commits.at(-1)).toEqual({
      command: "git_commit_paths",
      paths: [path],
    });
  } finally {
    await view.cleanup();
  }
});

test("after writing my text the next explicit commit commits the editor text", async () => {
  const path = "pages/refused-then-written.md";
  const view = await openSourceConflict(path);
  try {
    expect((await view.commitArea()) === null).toBe(false);
    await act(async () => view.conflicts.at(-1)!.writeDraft());
    await untilResolved(view);
    expect(view.commits).toEqual([]);

    expect(await view.commitPage()).toBeNull();
    expect(view.writes.at(-1)?.content).toBe(serialized(view.editor));
    expect(view.writes.at(-1)?.content.includes("Middle edited")).toBe(true);
    expect(view.commits).toEqual([
      { command: "git_commit_file", paths: [path] },
    ]);

    view.disk.dirty = true;
    useEditorStore.getState().markUnsaved(SPACE, path);
    expect(await view.commitArea()).toBeNull();
    expect(view.commits.at(-1)).toEqual({
      command: "git_commit_paths",
      paths: [path],
    });
  } finally {
    useEditorStore.getState().clearUnsaved(SPACE, path);
    await view.cleanup();
  }
});
