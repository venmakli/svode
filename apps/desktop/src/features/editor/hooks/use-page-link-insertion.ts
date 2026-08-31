import { useCallback } from "react";
import type { PlateEditor, useEditorRef } from "platejs/react";

import type { SearchItem } from "@/features/search";

import { makeRelativePageUrl } from "../api/page-link-api";
import { applyLinkUrl } from "../lib/page-link-editor-actions";
import { absoluteDocumentPath, joinAbs } from "../lib/page-link-utils";
import { useEditorDocumentContext } from "./use-resolved-asset-url";

type PageLinkEditor = ReturnType<typeof useEditorRef>;

function usePageLinkTargetUrl() {
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
      return makeRelativePageUrl(sourceAbs, joinAbs(item.spacePath, item.path));
    },
    [sourceAbs],
  );
}

export function useApplyPageLinkTarget(editor: PageLinkEditor) {
  const getRelativeDocUrl = usePageLinkTargetUrl();

  return useCallback(
    async (item: SearchItem) => {
      const url = await getRelativeDocUrl(item, false);
      if (!url) return;
      applyLinkUrl(editor, url, item.title);
    },
    [editor, getRelativeDocUrl],
  );
}

export function useInsertPageLinkTarget(editor: PlateEditor) {
  const getRelativeDocUrl = usePageLinkTargetUrl();

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
