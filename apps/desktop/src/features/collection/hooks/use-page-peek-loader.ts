import { useEffect, useState } from "react";
import { readPage as readPageApi } from "@/features/page/page-api";
import { applyPageTitleOutcome, type Page } from "@/features/page";
import {
  usePageTitleOutcomeEffect,
  useRetargetPage,
} from "@/features/page/navigation";
import { getPageSchema } from "@/features/properties/api";
import { normalizeSchema, type PageSchemaResult } from "@/features/properties";
import { handleError } from "./error-feedback";
import type { PagePeekTarget } from "../model";

export function usePagePeekLoader({
  target,
  spacePath,
  spaceId,
}: {
  target: PagePeekTarget | null;
  spacePath: string;
  spaceId: string;
}) {
  const [page, setPage] = useState<Page | null>(target?.page ?? null);
  const [schemaResult, setSchemaResult] = useState<PageSchemaResult | null>(
    null,
  );
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [pathHandoff, setPathHandoff] = useState<{
    previousPath: string;
    path: string;
  } | null>(null);
  const retargetPage = useRetargetPage();
  const targetKey = target
    ? pagePeekTargetKey(spacePath, target.page.path)
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!target) {
      queueMicrotask(() => {
        if (!cancelled) {
          setPage(null);
          setSchemaResult(null);
          setLoadedTargetKey(null);
          setPathHandoff(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setPage(target.page);
        setSchemaResult(null);
        setLoadedTargetKey(targetKey);
        setPathHandoff(null);
      }
    });

    if (target.nested) {
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([
      readPageApi({ spacePath, path: target.page.path }),
      getPageSchema({ spacePath, filePath: target.page.path }).catch(
        () => null,
      ),
    ])
      .then(([nextPage, nextSchemaResult]) => {
        if (cancelled) return;
        setPage(nextPage);
        setSchemaResult(
          nextSchemaResult
            ? {
                ...nextSchemaResult,
                schema: normalizeSchema(nextSchemaResult.schema),
              }
            : null,
        );
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [spacePath, target, targetKey]);

  usePageTitleOutcomeEffect({
    scopePath: spacePath,
    path: page?.path ?? target?.page.path ?? null,
    onOutcome: (titleOutcome) => {
      setPage((current) =>
        current ? applyPageTitleOutcome(current, titleOutcome.page) : current,
      );
      if (titleOutcome.previousPath === titleOutcome.page.path) return;
      setPathHandoff({
        previousPath: titleOutcome.previousPath,
        path: titleOutcome.page.path,
      });
      retargetPage(
        titleOutcome.previousPath,
        titleOutcome.page.path,
        spaceId,
      );
    },
  });

  return {
    page,
    setPage,
    schemaResult,
    setSchemaResult,
    loadedTargetKey,
    pathHandoff,
    targetKey,
  };
}

export function pagePeekTargetKey(spacePath: string, pagePath: string) {
  return `${spacePath.replaceAll("\\", "/").replace(/\/+$/g, "")}\0${pagePath.replaceAll("\\", "/")}`;
}

export function resolveLoadedPeekPage(
  target: PagePeekTarget | null,
  page: Page | null,
  loadedTargetKey: string | null,
  targetKey: string | null,
) {
  return target && loadedTargetKey === targetKey ? page : null;
}
