import { useEffect } from "react";
import { toast } from "sonner";
import {
  useContentDeleteConfirmation,
  useSpaceTreeSync,
} from "@/features/space";
import {
  ProjectRootHomeActions,
  SpaceHomeActions,
} from "@/features/space/app-shell";
import {
  ContentDeleteDialog,
  ContentHeaderMenu,
  contentActionGroups,
  pageFormOfPath,
  type DeletableContentObject,
} from "@/features/content-actions";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  signalCreatedArtifact,
  type NavigationItem,
} from "@/features/navigation";
import {
  createPage,
  deletePage,
  duplicatePage,
} from "@/features/page/page-api";
import { useOpenPage } from "@/features/page/navigation";
import {
  usePageDetailContext,
  usePageSurfaceSession,
} from "@/features/page/scope-surface";
import { handleError } from "@/features/page/detail";
import { PageDetailActions } from "@/features/page/detail";
import { publishPageFilenameWarnings, type Page } from "@/features/page";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import * as m from "@/paraglide/messages.js";

interface ScopeOwnerActionsProps {
  owner: ScopeOwnerRef;
  /** The owner object, pinned from this menu. */
  pinItem: NavigationItem;
  readOnly?: boolean;
}

/** The header menu of an owner's home page: the menu of the owner itself. */
export function ScopeOwnerActions(props: ScopeOwnerActionsProps) {
  const pageSurface = usePageSurfaceSession();
  const { owner, pinItem, readOnly } = props;
  if (owner.identityKind === "registered-space") {
    const homeProps = {
      spaceId: owner.spaceId,
      spacePath: owner.spacePath,
      projectPath: owner.projectPath,
      pinItem,
      readOnly,
      onBeforeNavigation: pageSurface.prepareForNavigation,
    };
    return owner.spacePath === owner.projectPath ? (
      <ProjectRootHomeActions {...homeProps} />
    ) : (
      <SpaceHomeActions {...homeProps} />
    );
  }
  return <ReadmeOwnerActions {...props} />;
}

/** What deleting the owner deletes, as its dialog names it. */
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
    default:
      return {
        kind: inCollection ? "collection-item" : "page",
        form: pageFormOfPath(page.path),
      };
  }
}

/** A Collection, an App or a Page, each shown with its README Page. */
function ReadmeOwnerActions({
  owner,
  pinItem,
  readOnly = false,
}: ScopeOwnerActionsProps) {
  const context = usePageDetailContext();
  const pageSurface = usePageSurfaceSession();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const { confirmation, requestDelete, cancelDelete } =
    useContentDeleteConfirmation<Page>();
  const {
    reloadTreeParent,
    reloadTreePathParent,
    reloadTreePathParents,
    removeTreePath,
  } = useSpaceTreeSync();

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
  const ownerPage = context.page;

  function requestOwnerDelete(page: Page) {
    void requestDelete({
      object: ownerDeleteObject(
        owner.identityKind,
        page,
        Boolean(context.schemaResult),
      ),
      name: page.meta.title,
      spacePath: context.spacePath,
      path: page.path,
      projectPath: context.projectPath,
      value: page,
    });
  }

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

  // "New item" of the sidebar: a new Page in the Collection's folder.
  async function newItem() {
    if (!(await pageSurface.prepareForNavigation())) return;
    const item = await createPage({
      spacePath: context.spacePath,
      parentPath: owner.ownerPath,
      title: String(m.editor_untitled()),
      allocateUniqueTitle: true,
      projectPath: context.projectPath,
    });
    publishPageFilenameWarnings(item.warnings);
    await reloadTreeParent(context.spaceId, owner.ownerPath);
    openPage(item.path, context.spaceId);
    signalCreatedArtifact(context.spaceId, item.path);
    toast.success(m.toast_page_created());
  }

  const menu =
    owner.identityKind === "collection-directory" ||
    owner.identityKind === "app-directory" ? (
      <ContentHeaderMenu
        groups={contentActionGroups({
          object: {
            kind:
              owner.identityKind === "collection-directory"
                ? "collection"
                : "app",
          },
          readOnly,
        })}
        pinItem={pinItem}
        handlers={{
          "new-item": () => void newItem().catch(handleError),
          rename: context.requestTitleFocus,
          delete: () => requestOwnerDelete(ownerPage),
        }}
      />
    ) : (
      <PageDetailActions
        page={ownerPage}
        menuKind={{
          kind: context.schemaResult ? "collection-item" : "page",
        }}
        pinItem={pinItem}
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
        onDeletePage={requestOwnerDelete}
        readOnly={readOnly}
      />
    );

  return (
    <>
      {menu}
      <ContentDeleteDialog
        confirmation={readOnly ? null : confirmation}
        onCancel={cancelDelete}
        onConfirm={(page) => void deleteOwner(page).catch(handleError)}
      />
    </>
  );
}
