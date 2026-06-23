import * as React from "react";

import { FileText, Loader2 } from "lucide-react";
import { useEditorRef } from "platejs/react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { SearchItem } from "@/features/search";
import { useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import { makeRelativeDocUrl } from "../api/doc-link-api";
import { useDocLinkTargetSearch } from "../hooks/use-doc-link-target-search";
import { useEditorDocumentContext } from "../hooks/use-resolved-asset-url";
import { applyLinkUrl } from "../lib/doc-link-editor-actions";
import {
  absoluteDocumentPath,
  findSpaceById,
  joinAbs,
} from "../lib/doc-link-utils";

export function DocLinkTargetPicker() {
  const editor = useEditorRef();
  const rootSpaces = useSpace((s) => s.rootSpaces);
  const spaces = useSpace((s) => s.spaces);
  const fileTrees = useSpace((s) => s.fileTrees);
  const editorDocument = useEditorDocumentContext();
  const [query, setQuery] = React.useState("");
  const projectPath = editorDocument?.projectPath ?? null;
  const activeDocument = editorDocument?.documentPath ?? null;
  const currentSpacePath = editorDocument?.spacePath ?? "";
  const sourceSpaceId = editorDocument?.sourceSpaceId ?? null;
  const sourceSpace =
    sourceSpaceId === null
      ? null
      : findSpaceById(rootSpaces, spaces, sourceSpaceId);
  const localCurrentSpace = React.useMemo(
    () =>
      sourceSpaceId !== null && sourceSpace
        ? {
            spaceId: sourceSpaceId,
            spacePath: sourceSpace.path,
            spaceName: sourceSpace.name,
            tree: fileTrees[sourceSpaceId] ?? [],
          }
        : null,
    [fileTrees, sourceSpace, sourceSpaceId],
  );
  const { items, loading } = useDocLinkTargetSearch({
    localCurrentSpace,
    projectPath,
    query,
    sourceSpaceId,
  });

  const sourceAbs =
    activeDocument && currentSpacePath
      ? absoluteDocumentPath(activeDocument, currentSpacePath)
      : null;

  async function selectItem(item: SearchItem) {
    if (!sourceAbs) return;
    const targetAbs = joinAbs(item.spacePath, item.path);
    const url = await makeRelativeDocUrl(sourceAbs, targetAbs);
    applyLinkUrl(editor, url, item.title);
  }

  return (
    <Command shouldFilter={false} className="h-[260px] rounded-md border">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={m.editor_doc_link_search()}
      />
      <CommandList>
        <CommandEmpty>
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {m.common_loading()}
            </span>
          ) : (
            m.editor_doc_link_no_results()
          )}
        </CommandEmpty>
        <CommandGroup>
          {items.map((item) => (
            <CommandItem
              key={`${item.spaceId ?? "root"}:${item.path}`}
              value={`${item.title} ${item.path} ${item.spaceName}`}
              onSelect={() => selectItem(item)}
              className="items-center gap-2 py-1.5"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col justify-center leading-none">
                <span className="truncate text-sm font-medium leading-4">
                  {item.title}
                </span>
                <span className="truncate text-[11px] leading-3 text-muted-foreground">
                  {item.spaceId === sourceSpaceId ||
                  (item.spaceId === null && sourceSpaceId === null)
                    ? item.path
                    : `${item.spaceName} · ${item.path}`}
                </span>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
