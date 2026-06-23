import type { PlateElementProps } from "platejs/react";
import type { TComboboxInputElement } from "platejs";

import { useMemo } from "react";
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
import { useSpace } from "@/features/space";
import { findSpaceById } from "../lib/doc-link-utils";
import { useInsertDocLinkTarget } from "../hooks/use-doc-link-insertion";
import { useDocLinkTargetSearch } from "../hooks/use-doc-link-target-search";
import { useEditorDocumentContext } from "../hooks/use-resolved-asset-url";

export function DocLinkInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  const rootSpaces = useSpace((s) => s.rootSpaces);
  const spaces = useSpace((s) => s.spaces);
  const fileTrees = useSpace((s) => s.fileTrees);
  const editorDocument = useEditorDocumentContext();
  const projectPath = editorDocument?.projectPath ?? null;
  const sourceSpaceId = editorDocument?.sourceSpaceId ?? null;
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
  const { items } = useDocLinkTargetSearch({
    debounceMs: 0,
    localCurrentSpace,
    projectPath,
    query: "",
    sourceSpaceId,
  });
  const insertDocLinkTarget = useInsertDocLinkTarget(editor);

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
                onClick={() => void insertDocLinkTarget(item)}
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
