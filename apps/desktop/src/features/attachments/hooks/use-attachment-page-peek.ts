import { useCallback, useEffect, useState } from "react";

import { applyPageTitleOutcome, type Page } from "@/features/page";
import { readPage } from "@/features/page/page-api";
import {
  usePageTitleOutcomeEffect,
  useRetargetPage,
} from "@/features/page/navigation";
import { getPageSchema } from "@/features/properties/api";
import type { PageSchemaResult } from "@/features/properties";

import type { AttachmentRow } from "../model/types";

type AttachmentPageState =
  | { phase: "initial" }
  | {
      phase: "ready";
      page: Page;
      schemaResult: PageSchemaResult | null;
      pathHandoff: { previousPath: string; path: string } | null;
    }
  | { phase: "error"; message: string };

export function useAttachmentPagePeek({
  row,
  spaceId,
  spacePath,
}: {
  row: AttachmentRow | null;
  spaceId: string;
  spacePath: string;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<AttachmentPageState>({ phase: "initial" });
  const retargetPage = useRetargetPage();
  const pagePath = row?.kind === "page" ? row.path : null;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setState({ phase: "initial" });
    });
    if (!pagePath) {
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([
      readPage({ path: pagePath, spacePath }),
      getPageSchema({ filePath: pagePath, spacePath }).catch(() => null),
    ])
      .then(([page, schemaResult]) => {
        if (!cancelled) {
          setState({ page, pathHandoff: null, phase: "ready", schemaResult });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ message: errorMessage(error), phase: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pagePath, reloadKey, spacePath]);

  usePageTitleOutcomeEffect({
    onOutcome: (outcome) => {
      setState((current) => {
        if (current.phase !== "ready") return current;
        const page = applyPageTitleOutcome(current.page, outcome.page);
        return {
          ...current,
          page,
          pathHandoff:
            outcome.previousPath === page.path
              ? current.pathHandoff
              : { path: page.path, previousPath: outcome.previousPath },
        };
      });
      if (outcome.previousPath !== outcome.page.path) {
        retargetPage(outcome.previousPath, outcome.page.path, spaceId);
      }
    },
    path: state.phase === "ready" ? state.page.path : pagePath,
    scopePath: spacePath,
  });

  const retry = useCallback(() => setReloadKey((current) => current + 1), []);
  return { retry, setState, state };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Page unavailable";
}
