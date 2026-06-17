"use client";

import type { PlateEditor } from "platejs/react";

import { insertCallout } from "@platejs/callout";
import { insertCodeBlock, toggleCodeBlock } from "@platejs/code-block";
import { insertCodeDrawing } from "@platejs/code-drawing";
import { insertDate } from "@platejs/date";
import { insertExcalidraw } from "@platejs/excalidraw";
import { insertColumnGroup, toggleColumnGroup } from "@platejs/layout";
import { triggerFloatingLink } from "@platejs/link/react";
import { insertEquation, insertInlineEquation } from "@platejs/math";
import { insertMediaEmbed } from "@platejs/media";
import { PlaceholderPlugin } from "@platejs/media/react";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { TablePlugin } from "@platejs/table/react";
import { insertToc } from "@platejs/toc";
import {
  type NodeEntry,
  type Path,
  type TElement,
  KEYS,
  PathApi,
} from "platejs";
import {
  defaultMediaAdapter,
  type MediaAdapter,
  type MediaKind,
} from "@/components/ui/media-adapter";

const ACTION_THREE_COLUMNS = "action_three_columns";

const insertList = (editor: PlateEditor, type: string) => {
  editor.tf.insertNodes(
    editor.api.create.block({
      indent: 1,
      listStyleType: type,
    }),
    { select: true },
  );
};

const insertBlockMap: Record<
  string,
  (editor: PlateEditor, type: string, mediaAdapter: MediaAdapter) => void
> = {
  [KEYS.listTodo]: insertList,
  [KEYS.ol]: insertList,
  [KEYS.ul]: insertList,
  [ACTION_THREE_COLUMNS]: (editor) =>
    insertColumnGroup(editor, { columns: 3, select: true }),
  [KEYS.audio]: (editor, _type, mediaAdapter) =>
    void pickAndInsertMedia(editor, "audio", mediaAdapter),
  [KEYS.callout]: (editor) => insertCallout(editor, { select: true }),
  [KEYS.codeBlock]: (editor) => insertCodeBlock(editor, { select: true }),
  [KEYS.codeDrawing]: (editor) =>
    insertCodeDrawing(editor, {}, { select: true }),
  [KEYS.equation]: (editor) => insertEquation(editor, { select: true }),
  [KEYS.excalidraw]: (editor) => insertExcalidraw(editor, {}, { select: true }),
  [KEYS.file]: (editor, _type, mediaAdapter) =>
    void pickAndInsertMedia(editor, "file", mediaAdapter),
  [KEYS.img]: (editor, _type, mediaAdapter) =>
    void pickAndInsertMedia(editor, "image", mediaAdapter),
  [KEYS.mediaEmbed]: (editor) => insertMediaEmbed(editor, { select: true }),
  [KEYS.table]: (editor) =>
    editor.getTransforms(TablePlugin).insert.table({}, { select: true }),
  [KEYS.toc]: (editor) => insertToc(editor, { select: true }),
  [KEYS.video]: (editor, _type, mediaAdapter) =>
    void pickAndInsertMedia(editor, "video", mediaAdapter),
};

/**
 * Hand selected files to the react-side `PlaceholderPlugin.insert.media`
 * transform. This is the correct path for programmatic media insertion from
 * slash commands and the block-insert menu: it sets the placeholder node `id`,
 * registers the file via `addUploadingFile`, and tags the history batch so
 * `updateUploadHistory` can patch it when the upload completes.
 */
export async function pickAndInsertMedia(
  editor: PlateEditor,
  kind: MediaKind,
  mediaAdapter: MediaAdapter,
) {
  const files = await mediaAdapter.pickFiles(kind);
  if (files.length === 0) return;

  editor
    .getTransforms(PlaceholderPlugin)
    .insert.media(mediaAdapter.filesToFileList(files), {
      nextBlock: false,
    });
}

const insertInlineMap: Record<
  string,
  (editor: PlateEditor, type: string) => void
> = {
  [KEYS.date]: (editor) => insertDate(editor, { select: true }),
  [KEYS.inlineEquation]: (editor) =>
    insertInlineEquation(editor, "", { select: true }),
  [KEYS.link]: (editor) => triggerFloatingLink(editor, { focused: true }),
};

type InsertBlockOptions = {
  mediaAdapter?: MediaAdapter;
  upsert?: boolean;
};

export const insertBlock = (
  editor: PlateEditor,
  type: string,
  options: InsertBlockOptions = {},
) => {
  const { mediaAdapter = defaultMediaAdapter, upsert = false } = options;

  editor.tf.withoutNormalizing(() => {
    const block = editor.api.block();

    if (!block) return;

    const [currentNode, path] = block;
    const isCurrentBlockEmpty = editor.api.isEmpty(currentNode);
    const currentBlockType = getBlockType(currentNode);

    const isSameBlockType = type === currentBlockType;

    if (upsert && isCurrentBlockEmpty && isSameBlockType) {
      return;
    }

    if (type in insertBlockMap) {
      insertBlockMap[type](editor, type, mediaAdapter);
    } else {
      editor.tf.insertNodes(editor.api.create.block({ type }), {
        at: PathApi.next(path),
        select: true,
      });
    }

    if (!isSameBlockType) {
      const removePreviousEmptyBlock = () => {
        editor.tf.removeNodes({ previousEmptyBlock: true });
      };
      const withoutSuggestions =
        editor.getApi(SuggestionPlugin)?.suggestion?.withoutSuggestions;

      if (withoutSuggestions) {
        withoutSuggestions(removePreviousEmptyBlock);
      } else {
        removePreviousEmptyBlock();
      }
    }
  });
};

export const insertInlineElement = (editor: PlateEditor, type: string) => {
  if (insertInlineMap[type]) {
    insertInlineMap[type](editor, type);
  }
};

const setList = (
  editor: PlateEditor,
  type: string,
  entry: NodeEntry<TElement>,
) => {
  editor.tf.setNodes(
    editor.api.create.block({
      indent: 1,
      listStyleType: type,
    }),
    {
      at: entry[1],
    },
  );
};

const setBlockMap: Record<
  string,
  (editor: PlateEditor, type: string, entry: NodeEntry<TElement>) => void
> = {
  [KEYS.listTodo]: setList,
  [KEYS.ol]: setList,
  [KEYS.ul]: setList,
  [ACTION_THREE_COLUMNS]: (editor) => toggleColumnGroup(editor, { columns: 3 }),
  [KEYS.codeBlock]: (editor) => toggleCodeBlock(editor),
};

export const setBlockType = (
  editor: PlateEditor,
  type: string,
  { at }: { at?: Path } = {},
) => {
  editor.tf.withoutNormalizing(() => {
    const setEntry = (entry: NodeEntry<TElement>) => {
      const [node, path] = entry;

      if (node[KEYS.listType]) {
        editor.tf.unsetNodes([KEYS.listType, "indent"], { at: path });
      }
      if (type in setBlockMap) {
        return setBlockMap[type](editor, type, entry);
      }
      if (node.type !== type) {
        editor.tf.setNodes({ type }, { at: path });
      }
    };

    if (at) {
      const entry = editor.api.node<TElement>(at);

      if (entry) {
        setEntry(entry);

        return;
      }
    }

    const entries = editor.api.blocks({ mode: "lowest" });

    entries.forEach((entry) => {
      setEntry(entry);
    });
  });
};

export const getBlockType = (block: TElement) => {
  if (block[KEYS.listType]) {
    if (block[KEYS.listType] === KEYS.ol) {
      return KEYS.ol;
    }
    if (block[KEYS.listType] === KEYS.listTodo) {
      return KEYS.listTodo;
    }
    return KEYS.ul;
  }

  return block.type;
};
