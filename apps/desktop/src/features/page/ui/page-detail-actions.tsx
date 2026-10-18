import { useEffect, useState } from "react";
import {
  ContentHeaderMenu,
  contentActionGroups,
  type ContentObject,
} from "@/features/content-actions";
import type { NavigationItem } from "@/features/navigation";
import { getPageDetailState } from "../page-api";
import type { Page, PageDetailState } from "../model";
import { normalizePagePath } from "../lib/path";
import { handleError } from "../lib/errors";
import { usePageDetailContext } from "../hooks/page-detail-context";
import { usePageContentOperations } from "../hooks/use-page-content-operations";

/** What the header menu tells the Page apart as. */
export type PageMenuKind =
  | { kind: "page" | "collection-item" | "app" }
  | { kind: "template"; isDefault: boolean };

interface PageDetailActionsProps {
  page: Page;
  menuKind: PageMenuKind;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  /** The Page pinned from this menu; a template is not pinned. */
  pinItem?: NavigationItem | null;
  onConverted?: (page: Page, nested: boolean) => void;
  onDuplicatePage: (page: Page) => void | Promise<void>;
  onDeletePage: (page: Page) => void;
  /** Makes the template the default of its Collection, or no longer. */
  onSetTemplateDefault?: (isDefault: boolean) => Promise<void>;
  readOnly?: boolean;
  runMutation?: (operation: () => Promise<void>) => Promise<void>;
}

export function PageDetailActions({
  page,
  menuKind,
  spacePath,
  projectPath,
  spaceId,
  pinItem = null,
  onConverted,
  onDuplicatePage,
  onDeletePage,
  onSetTemplateDefault,
  readOnly = false,
  runMutation = (operation) => operation(),
}: PageDetailActionsProps) {
  const { requestTitleFocus } = usePageDetailContext();
  const [state, setState] = useState<{
    path: string;
    detail: PageDetailState;
  } | null>(null);
  const currentState = state?.path === page.path ? state.detail : null;

  useEffect(() => {
    let cancelled = false;
    void getPageDetailState({
      spacePath,
      path: page.path,
    })
      .then((next) => {
        if (!cancelled) setState({ path: page.path, detail: next });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            path: page.path,
            detail: inferPageDetailState(page.path),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [page.path, spacePath]);

  const form = currentState?.form ?? inferPageDetailState(page.path).form;
  const operations = usePageContentOperations({
    spacePath,
    projectPath: projectPath ?? null,
    spaceId,
  });
  // A folder Page with its own schema is a Collection, as in the sidebar.
  const object: ContentObject =
    menuKind.kind === "app"
      ? { kind: "app" }
      : form === "nestedCollection"
        ? { kind: "collection" }
        : {
            ...menuKind,
            form,
            contents: currentState
              ? {
                  subpageCount: currentState.subpageCount,
                  otherFileCount: currentState.otherFileCount,
                }
              : null,
          };
  const groups = contentActionGroups({ object, readOnly });
  const makeLeafBlocked = groups.some((group) =>
    group.actions.some((action) => action.id === "make-leaf" && action.reason),
  );

  async function refreshDetailState(path: string) {
    const next = await getPageDetailState({ spacePath, path }).catch(
      () => null,
    );
    if (next) setState({ path, detail: next });
  }

  /** A leaf Page that took children is a folder Page now. */
  function adoptFolderPage(folderPage: Page | null) {
    if (!folderPage) return;
    setState({
      path: folderPage.path,
      detail: { form: "folder", subpageCount: 0, otherFileCount: 0 },
    });
  }

  async function nestPage() {
    const { childPage, folderPage } = await operations.nestPage(page);
    adoptFolderPage(folderPage);
    onConverted?.(childPage, false);
  }

  async function newFolder() {
    const { folderPage } = await operations.newFolder(page);
    adoptFolderPage(folderPage);
    if (folderPage) onConverted?.(folderPage, false);
    else await refreshDetailState(page.path);
  }

  async function convertToLeaf() {
    if (makeLeafBlocked) return;
    const next = await operations.makeLeaf(page);
    setState({
      path: next.path,
      detail: { form: "leaf", subpageCount: 0, otherFileCount: 0 },
    });
    onConverted?.(next, false);
  }

  async function convertToCollection() {
    const next = await operations.makeCollection(page);
    onConverted?.(next, true);
  }

  const mutate = (operation: () => Promise<void>) => () =>
    void runMutation(operation).catch(handleError);

  return (
    <ContentHeaderMenu
      groups={groups}
      pinItem={pinItem}
      handlers={{
        "set-template-default": () =>
          void onSetTemplateDefault?.(true).catch(handleError),
        "unset-template-default": () =>
          void onSetTemplateDefault?.(false).catch(handleError),
        "nest-page": mutate(nestPage),
        "new-item": mutate(nestPage),
        "new-folder": mutate(newFolder),
        "make-collection": mutate(convertToCollection),
        "make-leaf": mutate(convertToLeaf),
        rename: requestTitleFocus,
        duplicate: mutate(async () => {
          await onDuplicatePage(page);
        }),
        "duplicate-template": mutate(async () => {
          await onDuplicatePage(page);
        }),
        delete: () => onDeletePage(page),
      }}
    />
  );
}

function inferPageDetailState(path: string): PageDetailState {
  return normalizePagePath(path).toLowerCase().endsWith("/readme.md")
    ? { form: "folder", subpageCount: 0, otherFileCount: 0 }
    : { form: "leaf", subpageCount: 0, otherFileCount: 0 };
}
