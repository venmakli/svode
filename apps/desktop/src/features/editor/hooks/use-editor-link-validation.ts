import { useEffect } from "react";

import { validatePageLinks } from "@/features/page/page-api";

interface UseEditorLinkValidationInput {
  loadedDocumentKey: string | null;
  currentDocument: string | null;
  spacePath: string;
  projectPath: string | null;
  setBrokenLinks: (links: Set<string>) => void;
}

export function useEditorLinkValidation({
  loadedDocumentKey,
  currentDocument,
  spacePath,
  projectPath,
  setBrokenLinks,
}: UseEditorLinkValidationInput) {
  useEffect(() => {
    if (!loadedDocumentKey || !currentDocument || !spacePath) return;

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
          setBrokenLinks(broken);
        })
        .catch(() => {
          if (!cancelled) setBrokenLinks(new Set());
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    loadedDocumentKey,
    currentDocument,
    spacePath,
    projectPath,
    setBrokenLinks,
  ]);
}
