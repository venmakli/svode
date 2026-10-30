import { useEffect } from "react";
import type { PlateEditor } from "platejs/react";

import { validatePageLinks } from "@/features/page/page-api";

import { BrokenLinksPlugin } from "../plate/broken-links-plugin";

interface UseEditorLinkValidationInput {
  editor: PlateEditor | null;
  loadedDocumentKey: string | null;
  currentDocument: string | null;
  spacePath: string;
  projectPath: string | null;
}

export function useEditorLinkValidation({
  editor,
  loadedDocumentKey,
  currentDocument,
  spacePath,
  projectPath,
}: UseEditorLinkValidationInput) {
  useEffect(() => {
    if (!editor || !loadedDocumentKey || !currentDocument || !spacePath) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      validatePageLinks({
        spacePath,
        path: currentDocument,
        projectPath,
      })
        .then((results) => {
          if (cancelled) return;
          const broken = new Set(
            results
              .filter((result) => !result.exists)
              .map((result) => result.url),
          );
          editor.setOption(BrokenLinksPlugin, "brokenLinks", broken);
        })
        .catch(() => {
          if (!cancelled)
            editor.setOption(BrokenLinksPlugin, "brokenLinks", new Set());
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editor, loadedDocumentKey, currentDocument, spacePath, projectPath]);
}
