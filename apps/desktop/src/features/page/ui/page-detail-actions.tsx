import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Copy,
  Database,
  FilePlus,
  FileText,
  MoreVertical,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpaceTreeSync } from "@/features/space";
import {
  convertPageToFolder,
  convertPageToLeaf,
  convertPageToNestedCollection,
  createPage,
  getPageDetailState,
  readPage,
} from "../page-api";
import type { Page, PageDetailState } from "../model";
import { normalizePagePath } from "../lib/path";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";
import { publishPageFilenameWarnings } from "../lib/filename-warning";

interface PageDetailActionsProps {
  page: Page;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onConverted?: (page: Page, nested: boolean) => void;
  onDuplicatePage: (page: Page) => void | Promise<void>;
  onDeletePage: (page: Page) => void;
  actionItemsBeforeDuplicate?: ReactNode;
  duplicateLabel?: string;
  readOnly?: boolean;
  runMutation?: (operation: () => Promise<void>) => Promise<void>;
}

export function PageDetailActions({
  page,
  spacePath,
  projectPath,
  spaceId,
  onConverted,
  onDuplicatePage,
  onDeletePage,
  actionItemsBeforeDuplicate,
  duplicateLabel,
  readOnly = false,
  runMutation = (operation) => operation(),
}: PageDetailActionsProps) {
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
  const leafDisabledReason = useMemo(() => {
    if (!currentState || form !== "folder") return null;
    const blocked =
      currentState.subpageCount > 0 || currentState.otherFileCount > 0;
    if (!blocked) return null;
    return m.page_convert_leaf_blocked({
      subpages: currentState.subpageCount,
      files: currentState.otherFileCount,
    });
  }, [currentState, form]);

  async function refreshDetail(path: string, changedPaths: string[] = [path]) {
    await reloadTreePathParents(spaceId, changedPaths);
    const [nextPage, nextState] = await Promise.all([
      readPage({ spacePath, path }),
      getPageDetailState({
        spacePath,
        path,
      }).catch(() => null),
    ]);
    if (nextState) setState({ path, detail: nextState });
    return nextPage;
  }

  async function nestPage() {
    const folderPage = await convertPageToFolder({
      spacePath,
      filePath: page.path,
      projectPath: projectPath ?? null,
    });
    const parentPath = normalizePagePath(folderPage.path).replace(
      /\/readme\.md$/i,
      "",
    );
    const childPage = await createPage({
      spacePath,
      parentPath,
      title: String(m.editor_untitled()),
      allocateUniqueTitle: true,
      contextualDefaults: null,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(childPage.warnings);
    await reloadTreePathParents(spaceId, [page.path, folderPage.path]);
    await reloadTreeParent(spaceId, parentPath);
    setState({
      path: folderPage.path,
      detail: { form: "folder", subpageCount: 0, otherFileCount: 0 },
    });
    onConverted?.(childPage, false);
  }

  async function convertToLeaf() {
    if (leafDisabledReason) return;
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

  async function convertToNestedCollection() {
    await convertPageToNestedCollection({
      spacePath,
      filePath: page.path,
      projectPath: projectPath ?? null,
    });
    const next = await refreshDetail(page.path, [page.path]);
    onConverted?.(next, true);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <MoreVertical />
          <span className="sr-only">{m.content_actions()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {form === "leaf" ? (
          <DropdownMenuItem
            disabled={readOnly}
            onClick={() => void runMutation(nestPage).catch(handleError)}
          >
            <FilePlus data-icon="inline-start" />
            {m.space_nest_page()}
          </DropdownMenuItem>
        ) : null}
        {form === "folder" ? (
          <>
            <DropdownMenuItem
              disabled={readOnly || Boolean(leafDisabledReason)}
              title={leafDisabledReason ?? undefined}
              onSelect={(event) => {
                if (leafDisabledReason) {
                  event.preventDefault();
                  return;
                }
                void runMutation(convertToLeaf).catch(handleError);
              }}
            >
              <FileText data-icon="inline-start" />
              {m.page_convert_to_leaf()}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly}
              onClick={() =>
                void runMutation(convertToNestedCollection).catch(handleError)
              }
            >
              <Database data-icon="inline-start" />
              {m.page_convert_to_nested_collection()}
            </DropdownMenuItem>
          </>
        ) : null}
        {actionItemsBeforeDuplicate}
        <DropdownMenuItem
          disabled={readOnly}
          onClick={() =>
            void runMutation(async () => {
              await onDuplicatePage(page);
            }).catch(handleError)
          }
        >
          <Copy data-icon="inline-start" />
          {duplicateLabel ?? m.page_duplicate()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={readOnly}
          onClick={() => onDeletePage(page)}
        >
          <Trash2 data-icon="inline-start" />
          {m.page_delete_row()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function inferPageDetailState(path: string): PageDetailState {
  return normalizePagePath(path).toLowerCase().endsWith("/readme.md")
    ? { form: "folder", subpageCount: 0, otherFileCount: 0 }
    : { form: "leaf", subpageCount: 0, otherFileCount: 0 };
}
