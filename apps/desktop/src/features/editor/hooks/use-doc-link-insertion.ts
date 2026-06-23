import { useCallback } from "react";
import type { PlateEditor, useEditorRef } from "platejs/react";

import type { SearchItem } from "@/features/search";

import { makeRelativeDocUrl } from "../api/doc-link-api";
import { applyLinkUrl } from "../lib/doc-link-editor-actions";
import { absoluteDocumentPath, joinAbs } from "../lib/doc-link-utils";
import { useEditorDocumentContext } from "./use-resolved-asset-url";

type DocLinkEditor = ReturnType<typeof useEditorRef>;

function useDocLinkTargetUrl() {
  const editorDocument = useEditorDocumentContext();
  const sourceAbs =
    editorDocument?.documentPath && editorDocument.spacePath
      ? absoluteDocumentPath(
          editorDocument.documentPath,
          editorDocument.spacePath,
        )
      : null;

  return useCallback(
    async (item: SearchItem, fallbackToItemPath: boolean) => {
      if (!sourceAbs) return fallbackToItemPath ? item.path : null;
      return makeRelativeDocUrl(sourceAbs, joinAbs(item.spacePath, item.path));
    },
    [sourceAbs],
  );
}

export function useApplyDocLinkTarget(editor: DocLinkEditor) {
  const getRelativeDocUrl = useDocLinkTargetUrl();

  return useCallback(
    async (item: SearchItem) => {
      const url = await getRelativeDocUrl(item, false);
      if (!url) return;
      applyLinkUrl(editor, url, item.title);
    },
    [editor, getRelativeDocUrl],
  );
}

export function useInsertDocLinkTarget(editor: PlateEditor) {
  const getRelativeDocUrl = useDocLinkTargetUrl();

  return useCallback(
    async (item: SearchItem) => {
      const url = await getRelativeDocUrl(item, true);
      if (!url) return;
      editor.tf.insertNodes({
        type: "a",
        url,
        children: [{ text: item.title }],
      });
    },
    [editor, getRelativeDocUrl],
  );
}
