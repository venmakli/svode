import { useEffect } from "react";
import {
  useContentDeleteConfirmation,
  useSpaceTreeSync,
} from "@/features/space";
import {
  ContentDeleteDialog,
  pageFormOfPath,
  type DeletableContentObject,
} from "@/features/content-actions";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  NavigationMenuItems,
  signalCreatedArtifact,
  type NavigationItem,
} from "@/features/navigation";
import { deletePage, duplicatePage } from "@/features/page/page-api";
import { useOpenPage } from "@/features/page/navigation";
import { usePageDetailContext } from "@/features/page/scope-surface";
import { handleError } from "@/features/page/detail";
import { PageDetailActions } from "@/features/page/detail";
import { publishPageFilenameWarnings, type Page } from "@/features/page";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

/** What deleting the owner's README deletes, as its dialog names it. */
function ownerDeleteObject(
  identityKind: ScopeOwnerRef["identityKind"],
  page: Page,
  inCollection: boolean,
): DeletableContentObject {
  switch (identityKind) {
    case "collection-directory":
      return { kind: "collection" };
    case "app-directory":
      return { kind: "app" };
    // The README of a Space is one file of the Space.
    case "registered-space":
      return { kind: "page", form: "leaf" };
    default:
      return {
        kind: inCollection ? "collection-item" : "page",
        form: pageFormOfPath(page.path),
      };
  }
}

export function ScopeOwnerActions({
  ownerKind,
  pinItem,
  readOnly = false,
}: {
  ownerKind: ScopeOwnerRef["identityKind"];
  /** The owner object, pinned from this menu. */
  pinItem: NavigationItem;
  readOnly?: boolean;
}) {
  const context = usePageDetailContext();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const { confirmation, requestDelete, cancelDelete } =
    useContentDeleteConfirmation<Page>();
  const { reloadTreePathParent, reloadTreePathParents, removeTreePath } =
    useSpaceTreeSync();

  useEffect(() => {
    if (!readOnly) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) cancelDelete();
    });
    return () => {
      cancelled = true;
    };
  }, [cancelDelete, readOnly]);

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
    signalCreatedArtifact(context.spaceId, duplicated.path);
  }

  async function deleteOwner(page: Page) {
    await deletePage({
      spacePath: context.spacePath,
      path: page.path,
      projectPath: context.projectPath,
    });
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
        onDuplicatePage={(page) => void duplicateOwner(page).catch(handleError)}
        onDeletePage={(page) =>
          void requestDelete({
            object: ownerDeleteObject(
              ownerKind,
              page,
              Boolean(context.schemaResult),
            ),
            name: page.meta.title,
            spacePath: context.spacePath,
            path: page.path,
            projectPath: context.projectPath,
            value: page,
          })
        }
        actionItemsBeforeDuplicate={<NavigationMenuItems item={pinItem} />}
        readOnly={readOnly}
      />
      <ContentDeleteDialog
        confirmation={readOnly ? null : confirmation}
        onCancel={cancelDelete}
        onConfirm={(page) => void deleteOwner(page).catch(handleError)}
      />
    </>
  );
}
