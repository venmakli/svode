import type { PlateElementProps } from "platejs/react";
import type { TComboboxInputElement } from "platejs";

import { useEffect, useMemo, useState } from "react";
import { PlateElement } from "platejs/react";
import * as m from "@/paraglide/messages.js";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxInput,
  InlineComboboxItem,
} from "@/components/ui/inline-combobox";
import { FileText } from "lucide-react";
import { useSpaceStore } from "@/features/space/model";
import { useEntrySelectionStore } from "@/features/entry";
import type { SearchItem } from "@/features/search";
import {
  absoluteDocumentPath,
  findSpaceById,
  joinAbs,
  makeRelativeDocUrl,
  searchDocLinkTargets,
} from "../lib/doc-link-utils";

export function DocLinkInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const activeRootPath = useSpaceStore((s) => s.activeRootPath);
  const rootSpaces = useSpaceStore((s) => s.rootSpaces);
  const spaces = useSpaceStore((s) => s.spaces);
  const fileTrees = useSpaceStore((s) => s.fileTrees);
  const activeDocument = useEntrySelectionStore((s) => s.activeDocument);
  const activeDocumentSpaceId = useEntrySelectionStore(
    (s) => s.activeDocumentSpaceId,
  );
  const [items, setItems] = useState<SearchItem[]>([]);
  const sourceSpaceId =
    activeDocumentSpaceId === activeRootId ? null : activeDocumentSpaceId;
  const sourceSpace =
    sourceSpaceId === null
      ? null
      : findSpaceById(rootSpaces, spaces, sourceSpaceId);
  const localCurrentSpace = useMemo(
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

  useEffect(() => {
    if (!activeRootPath) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setItems([]);
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    searchDocLinkTargets(activeRootPath, sourceSpaceId, "", localCurrentSpace)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((err) => {
        console.error("doc link input search failed:", err);
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRootPath, sourceSpaceId, localCurrentSpace]);

  const currentSpace = findSpaceById(rootSpaces, spaces, activeDocumentSpaceId);
  const currentSpacePath = currentSpace?.path ?? activeRootPath ?? "";

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/doc" showTrigger={false}>
        <InlineComboboxInput
          aria-label={m.editor_doc_link_search()}
          className="placeholder:text-muted-foreground"
          placeholder={m.editor_doc_link_search()}
        />
        <InlineComboboxContent>
          <InlineComboboxEmpty>
            {m.editor_doc_link_no_results()}
          </InlineComboboxEmpty>
          <InlineComboboxGroup>
            {items.map((item) => (
              <InlineComboboxItem
                key={`${item.spaceId ?? "root"}:${item.path}`}
                value={item.path}
                label={item.title}
                focusEditor
                keywords={[item.title, item.path, item.spaceName]}
                className="h-auto min-h-[38px] items-center gap-2 py-1"
                onClick={async () => {
                  const sourceAbs =
                    activeDocument && currentSpacePath
                      ? absoluteDocumentPath(activeDocument, currentSpacePath)
                      : null;
                  const targetAbs = joinAbs(item.spacePath, item.path);
                  const relativePath = sourceAbs
                    ? await makeRelativeDocUrl(sourceAbs, targetAbs)
                    : item.path;
                  editor.tf.insertNodes({
                    type: "a",
                    url: relativePath,
                    children: [{ text: item.title }],
                  });
                }}
              >
                <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {item.icon && item.icon !== "📄" ? (
                    <span className="text-sm leading-none">{item.icon}</span>
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                </div>
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
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}
