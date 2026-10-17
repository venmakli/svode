import { useEffect, useState } from "react";
import {
  ContentHeaderMenu,
  contentActionGroups,
  type ContentObject,
} from "@/features/content-actions";
import type { NavigationItem } from "@/features/navigation";
import { useSpaceTreeSync } from "@/features/space";
import {
  convertPageToFolder,
  convertPageToLeaf,
  convertPageToNestedCollection,
  createPage,
  createPageFolder,
  getPageDetailState,
} from "../page-api";
import type { Page, PageDetailState } from "../model";
import { normalizePagePath } from "../lib/path";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import { usePageDetailContext } from "../hooks/page-detail-context";

/** What the header menu tells the Page apart as. */
export type PageMenuKind =
  | { kind: "page" | "collection-item" }
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
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  // A folder Page with its own schema is a Collection, as in the sidebar.
  const object: ContentObject =
    form === "nestedCollection"
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

  /** The folder children go in; a leaf Page first becomes a folder Page. */
  async function childFolder(): Promise<{
    folderPage: Page | null;
    folderPath: string;
  }> {
    if (form !== "leaf") {
      return { folderPage: null, folderPath: readmeFolderPath(page.path) };
    }
    const folderPage = await convertPageToFolder({
      spacePath,
      filePath: page.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParents(spaceId, [page.path, folderPage.path]);
    setState({
      path: folderPage.path,
      detail: { form: "folder", subpageCount: 0, otherFileCount: 0 },
    });
    return { folderPage, folderPath: readmeFolderPath(folderPage.path) };
  }

  async function nestPage() {
    const { folderPath } = await childFolder();
    const childPage = await createPage({
      spacePath,
      parentPath: folderPath,
      title: String(m.editor_untitled()),
      allocateUniqueTitle: true,
      contextualDefaults: null,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(childPage.warnings);
    await reloadTreeParent(spaceId, folderPath);
    onConverted?.(childPage, false);
  }

  async function newFolder() {
    const { folderPage, folderPath } = await childFolder();
    await createPageFolder({
      spacePath,
      parentPath: folderPath,
      name: m.space_new_folder(),
      projectPath: projectPath ?? null,
    });
    await reloadTreeParent(spaceId, folderPath);
    if (folderPage) onConverted?.(folderPage, false);
    else await refreshDetailState(page.path);
  }

  async function convertToLeaf() {
    if (makeLeafBlocked) return;
    const next = await convertPageToLeaf({
      spacePath,
      filePath: page.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParents(spaceId, [page.path, next.path]);
    setState({
      path: next.path,
      detail: { form: "leaf", subpageCount: 0, otherFileCount: 0 },
    });
    onConverted?.(next, false);
  }

  async function convertToCollection() {
    const next = await convertPageToNestedCollection({
      spacePath,
      filePath: page.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParents(spaceId, [page.path, next.path]);
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

function readmeFolderPath(path: string): string {
  return normalizePagePath(path).replace(/\/readme\.md$/i, "");
}

function inferPageDetailState(path: string): PageDetailState {
  return normalizePagePath(path).toLowerCase().endsWith("/readme.md")
    ? { form: "folder", subpageCount: 0, otherFileCount: 0 }
    : { form: "leaf", subpageCount: 0, otherFileCount: 0 };
}
