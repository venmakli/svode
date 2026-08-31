import { useEffect, useState } from "react";
import { useSpaceTreeSync } from "@/features/space";
import { useOpenScopeOwner } from "@/features/artifact";
import { deletePage, duplicatePage } from "@/features/page/page-api";
import { useOpenPage } from "@/features/page/navigation";
import { usePageDetailContext } from "@/features/page/scope-surface";
import { handleError } from "@/features/page/detail";
import {
  PageDeleteDialog,
  PageDetailActions,
} from "@/features/page/detail";
import { publishPageFilenameWarnings, type Page } from "@/features/page";

export function ScopeOwnerActions({
  readOnly = false,
}: {
  readOnly?: boolean;
}) {
  const context = usePageDetailContext();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const [pageToDelete, setPageToDelete] = useState<Page | null>(null);
  const { reloadTreePathParent, reloadTreePathParents, removeTreePath } =
    useSpaceTreeSync();

  useEffect(() => {
    if (!readOnly) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setPageToDelete(null);
    });
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  if (!context.page) return null;

  async function duplicateOwner(page: Page) {
    const duplicated = await duplicatePage({
      spacePath: context.spacePath,
      filePath: page.path,
      projectPath: context.projectPath,
    });
    publishPageFilenameWarnings(duplicated.warnings);
    await reloadTreePathParent(context.spaceId, duplicated.path);
    openPage(duplicated.path, context.spaceId);
  }

  async function deleteOwner(page: Page) {
    await deletePage({
      spacePath: context.spacePath,
      path: page.path,
      projectPath: context.projectPath,
    });
    setPageToDelete(null);
    removeTreePath(context.spaceId, page.path);
    await reloadTreePathParent(context.spaceId, page.path);
    await context.reload();
  }

  return (
    <>
      <PageDetailActions
        page={context.page}
        spacePath={context.spacePath}
        projectPath={context.projectPath}
        spaceId={context.spaceId}
        onConverted={(page, nested) => {
          context.setPage(page);
          if (nested) {
            openScopeOwner({
              kind: "collection",
              path: page.path,
              spaceId: context.spaceId,
            });
            void reloadTreePathParents(context.spaceId, [page.path]);
          } else {
            openPage(page.path, context.spaceId);
          }
        }}
        onDuplicatePage={(page) =>
          void duplicateOwner(page).catch(handleError)
        }
        onDeletePage={setPageToDelete}
        readOnly={readOnly}
      />
      <PageDeleteDialog
        page={readOnly ? null : pageToDelete}
        onOpenChange={(open) => {
          if (!open) setPageToDelete(null);
        }}
        onDeletePage={(page) => void deleteOwner(page).catch(handleError)}
      />
    </>
  );
}
