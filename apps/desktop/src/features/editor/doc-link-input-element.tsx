import type { PlateElementProps } from "platejs/react";
import type { TComboboxInputElement } from "platejs";

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
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import type { TreeNode } from "@/types/workspace";

interface DocItem {
  title: string;
  path: string;
  icon: string | null;
}

/** Flatten tree into a list of documents. */
function flattenTree(nodes: TreeNode[]): DocItem[] {
  const items: DocItem[] = [];
  for (const node of nodes) {
    items.push({ title: node.title, path: node.path, icon: node.icon });
    if (node.children.length > 0) {
      items.push(...flattenTree(node.children));
    }
  }
  return items;
}

/** Compute relative path from source document to target. */
function makeRelativePath(fromPath: string, toPath: string): string {
  const fromParts = fromPath.split("/");
  fromParts.pop(); // Remove filename to get directory
  const toParts = toPath.split("/");

  // Find common prefix
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  // Build relative path
  const ups = fromParts.length - common;
  const parts = [
    ...Array(ups).fill(".."),
    ...toParts.slice(common),
  ];
  return parts.join("/") || toPath;
}

export function DocLinkInputElement(
  props: PlateElementProps<TComboboxInputElement>,
) {
  const { editor, element } = props;
  const { activeWorkspaceId, fileTrees } = useWorkspaceStore();
  const { activeDocument } = useLayoutStore();

  const tree = activeWorkspaceId ? fileTrees[activeWorkspaceId] ?? [] : [];
  const docItems = flattenTree(tree);

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="[[">
        <InlineComboboxInput />
        <InlineComboboxContent>
          <InlineComboboxEmpty>
            {m.editor_doc_link_no_results()}
          </InlineComboboxEmpty>
          <InlineComboboxGroup>
            {docItems.map((item) => (
              <InlineComboboxItem
                key={item.path}
                value={item.path}
                label={item.title}
                focusEditor
                keywords={[item.title, item.path]}
                onClick={() => {
                  // Insert a standard link node
                  const relativePath = activeDocument
                    ? makeRelativePath(activeDocument, item.path)
                    : item.path;
                  editor.tf.insertNodes({
                    type: "a",
                    url: relativePath,
                    children: [{ text: item.title }],
                  });
                }}
              >
                <div className="mr-2 text-muted-foreground">
                  {item.icon ? (
                    <span className="text-sm">{item.icon}</span>
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                </div>
                {item.title}
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}
