import { useCallback } from "react";
import { pageFormOfPath } from "@/features/content-actions";
import type { Page } from "@/features/page";
import { useContentDeleteConfirmation } from "@/features/space";
import type { PagePeekTarget } from "../model";
import { handleError } from "./error-feedback";

/** Where a Peek deletes its item, which may live outside this Collection. */
export interface PeekDeleteTarget {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
}

interface ItemDeleteValue {
  page: Page;
  peekTarget?: PeekDeleteTarget;
}

/**
 * The delete confirmation of the Collection's items and of its Peek. An item
 * deletes only while the Collection is writable; a Peek item, which may be a
 * template or live in another Space, keeps its own target.
 */
export function useCollectionItemDelete({
  readOnly,
  spacePath,
  projectPath,
  deleteItem,
}: {
  readOnly: boolean;
  spacePath: string;
  projectPath?: string | null;
  deleteItem: (page: Page, peekTarget?: PeekDeleteTarget) => Promise<void>;
}) {
  const { confirmation, requestDelete, cancelDelete } =
    useContentDeleteConfirmation<ItemDeleteValue>();

  const requestItemDelete = useCallback(
    (page: Page) => {
      if (readOnly) return;
      void requestDelete({
        object: { kind: "collection-item", form: pageFormOfPath(page.path) },
        name: page.meta.title,
        spacePath,
        path: page.path,
        projectPath: projectPath ?? null,
        value: { page },
      });
    },
    [projectPath, readOnly, requestDelete, spacePath],
  );

  const requestPeekDelete = useCallback(
    (
      page: Page,
      target: PeekDeleteTarget,
      template?: PagePeekTarget["template"],
    ) => {
      const form = pageFormOfPath(page.path);
      void requestDelete({
        object: template
          ? { kind: "template", form, isDefault: template.isDefault }
          : { kind: "collection-item", form },
        name: page.meta.title,
        spacePath: target.spacePath,
        path: page.path,
        projectPath: target.projectPath ?? null,
        value: { page, peekTarget: target },
      });
    },
    [requestDelete],
  );

  return {
    dialog: {
      confirmation:
        confirmation?.value.peekTarget || !readOnly ? confirmation : null,
      onCancel: cancelDelete,
      onConfirm: ({ page, peekTarget }: ItemDeleteValue) =>
        void deleteItem(page, peekTarget).catch(handleError),
    },
    requestItemDelete,
    requestPeekDelete,
    cancelDelete,
  };
}
