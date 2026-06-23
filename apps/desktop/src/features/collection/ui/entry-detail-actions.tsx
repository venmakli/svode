import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Database,
  FilePlus,
  FileText,
  MoreVertical,
  Star,
  StarOff,
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
  convertEntryToFolder,
  convertEntryToLeaf,
  convertEntryToNestedCollection,
  createEntry,
  readEntry,
} from "@/features/entry/entry-api";
import type { Entry } from "@/features/entry";
import { getEntryDetailState } from "../api";
import { normalizeEntryPath } from "../lib/utils";
import { handleError } from "../lib/errors";
import type { EntryDetailState } from "../model";
import * as m from "@/paraglide/messages.js";

interface EntryDetailActionsProps {
  entry: Entry;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onConverted?: (entry: Entry, nested: boolean) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (entry: Entry) => Promise<void>;
}

export function EntryDetailActions({
  entry,
  spacePath,
  projectPath,
  spaceId,
  onConverted,
  onDuplicateEntry,
  onDeleteEntry,
  template,
  onSetTemplateDefault,
  onDuplicateTemplate,
}: EntryDetailActionsProps) {
  const [state, setState] = useState<{
    path: string;
    detail: EntryDetailState;
  } | null>(null);
  const currentState = state?.path === entry.path ? state.detail : null;

  useEffect(() => {
    let cancelled = false;
    void getEntryDetailState({
      spacePath,
      path: entry.path,
    })
      .then((next) => {
        if (!cancelled) setState({ path: entry.path, detail: next });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            path: entry.path,
            detail: inferEntryDetailState(entry.path),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, spacePath]);

  const form = currentState?.form ?? inferEntryDetailState(entry.path).form;
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const leafDisabledReason = useMemo(() => {
    if (!currentState || form !== "folder") return null;
    const blocked =
      currentState.subpageCount > 0 || currentState.otherFileCount > 0;
    if (!blocked) return null;
    return m.entry_convert_leaf_blocked({
      subpages: currentState.subpageCount,
      files: currentState.otherFileCount,
    });
  }, [currentState, form]);

  async function refreshDetail(path: string, changedPaths: string[] = [path]) {
    await reloadTreePathParents(spaceId, changedPaths);
    const [nextEntry, nextState] = await Promise.all([
      readEntry({ spacePath, path }),
      getEntryDetailState({
        spacePath,
        path,
      }).catch(() => null),
    ]);
    if (nextState) setState({ path, detail: nextState });
    return nextEntry;
  }

  async function nestPage() {
    const folderEntry = await convertEntryToFolder({
      spacePath,
      filePath: entry.path,
      projectPath: projectPath ?? null,
    });
    const parentPath = normalizeEntryPath(folderEntry.path).replace(
      /\/readme\.md$/i,
      "",
    );
    const childEntry = await createEntry({
      spacePath,
      parentPath,
      title: String(m.editor_untitled()),
      contextualDefaults: null,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParents(spaceId, [entry.path, folderEntry.path]);
    await reloadTreeParent(spaceId, parentPath);
    setState({
      path: folderEntry.path,
      detail: { form: "folder", subpageCount: 0, otherFileCount: 0 },
    });
    onConverted?.(childEntry, false);
  }

  async function convertToLeaf() {
    if (leafDisabledReason) return;
    const next = await convertEntryToLeaf({
      spacePath,
      filePath: entry.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParents(spaceId, [entry.path, next.path]);
    setState({
      path: next.path,
      detail: { form: "leaf", subpageCount: 0, otherFileCount: 0 },
    });
    onConverted?.(next, false);
  }

  async function convertToNestedCollection() {
    await convertEntryToNestedCollection({
      spacePath,
      filePath: entry.path,
      projectPath: projectPath ?? null,
    });
    const next = await refreshDetail(entry.path, [entry.path]);
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
          <span className="sr-only">{m.entry_actions()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {form === "leaf" ? (
          <DropdownMenuItem onClick={() => void nestPage().catch(handleError)}>
            <FilePlus data-icon="inline-start" />
            {m.space_nest_page()}
          </DropdownMenuItem>
        ) : null}
        {form === "folder" ? (
          <>
            <DropdownMenuItem
              disabled={Boolean(leafDisabledReason)}
              title={leafDisabledReason ?? undefined}
              onSelect={(event) => {
                if (leafDisabledReason) {
                  event.preventDefault();
                  return;
                }
                void convertToLeaf().catch(handleError);
              }}
            >
              <FileText data-icon="inline-start" />
              {m.entry_convert_to_leaf()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void convertToNestedCollection().catch(handleError)
              }
            >
              <Database data-icon="inline-start" />
              {m.entry_convert_to_nested_collection()}
            </DropdownMenuItem>
          </>
        ) : null}
        {template && onSetTemplateDefault ? (
          template.isDefault ? (
            <DropdownMenuItem
              onClick={() => void onSetTemplateDefault(null).catch(handleError)}
            >
              <StarOff data-icon="inline-start" />
              {m.collection_template_unset_default()}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                void onSetTemplateDefault(template.slug).catch(handleError)
              }
            >
              <Star data-icon="inline-start" />
              {m.collection_template_set_default()}
            </DropdownMenuItem>
          )
        ) : null}
        <DropdownMenuItem
          onClick={() => {
            if (template && onDuplicateTemplate) {
              void onDuplicateTemplate(entry).catch(handleError);
              return;
            }
            onDuplicateEntry(entry);
          }}
        >
          <Copy data-icon="inline-start" />
          {template
            ? m.collection_template_duplicate()
            : m.collection_duplicate_entry()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onDeleteEntry(entry)}
        >
          <Trash2 data-icon="inline-start" />
          {m.entry_delete_row()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function inferEntryDetailState(path: string): EntryDetailState {
  return normalizeEntryPath(path).toLowerCase().endsWith("/readme.md")
    ? { form: "folder", subpageCount: 0, otherFileCount: 0 }
    : { form: "leaf", subpageCount: 0, otherFileCount: 0 };
}
