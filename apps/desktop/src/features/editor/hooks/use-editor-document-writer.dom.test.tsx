import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import { NodeApi, type Descendant } from "platejs";
import { createPlateEditor, type PlateEditor } from "platejs/react";
import type { Page, PageSourceConflict } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
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

async function harness(path: string, body: string) {
  const dom = await createTestDom();
  const disk = { body, version: "v1" };
  const writes: WriteCall[] = [];
  const conflicts: (PageSourceConflict | null)[] = [];
  let reads = 0;
  mockNativeIpc((command, args) => {
    const input = args as Record<string, string>;
    if (command === "read_page") {
      reads += 1;
      return page(path, disk.body, disk.version);
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
    if (command === "git_status") return { files: [] };
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
    return null;
  }

  await dom.render(<Writer />);
  // Loads the source the way discarding a draft does: editor value and baseline.
  await act(() => writerRef.current!.discardPendingSource());

  return {
    editor,
    writes,
    conflicts,
    disk,
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
