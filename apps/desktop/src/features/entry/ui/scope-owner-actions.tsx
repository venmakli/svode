import { useState } from "react";
import { useSpaceTreeSync } from "@/features/space";
import { deleteEntry, duplicateEntry } from "../entry-api";
import { useOpenEntryDocument } from "../selection";
import { useEntryDetailContext } from "../hooks/entry-detail-context";
import { handleError } from "../lib/errors";
import type { Entry } from "../model";
import { EntryDeleteDialog } from "./entry-delete-dialog";
import { EntryDetailActions } from "./entry-detail-actions";

export function ScopeOwnerActions() {
  const context = useEntryDetailContext();
  const openDocument = useOpenEntryDocument();
  const [entryToDelete, setEntryToDelete] = useState<Entry | null>(null);
  const { reloadTreePathParent, reloadTreePathParents, removeTreePath } =
    useSpaceTreeSync();

  if (!context.entry) return null;

  async function duplicateOwner(entry: Entry) {
    const duplicated = await duplicateEntry({
      spacePath: context.spacePath,
      filePath: entry.path,
      projectPath: context.projectPath,
    });
    await reloadTreePathParent(context.spaceId, duplicated.path);
    openDocument(duplicated.path, context.spaceId);
  }

  async function deleteOwner(entry: Entry) {
    await deleteEntry({
      spacePath: context.spacePath,
      path: entry.path,
      projectPath: context.projectPath,
    });
    setEntryToDelete(null);
    removeTreePath(context.spaceId, entry.path);
    await reloadTreePathParent(context.spaceId, entry.path);
    await context.reload();
  }

  return (
    <>
      <EntryDetailActions
        entry={context.entry}
        spacePath={context.spacePath}
        projectPath={context.projectPath}
        spaceId={context.spaceId}
        onConverted={(entry, nested) => {
          context.setEntry(entry);
          openDocument(entry.path, context.spaceId);
          if (nested) {
            void reloadTreePathParents(context.spaceId, [entry.path]);
          }
        }}
        onDuplicateEntry={(entry) =>
          void duplicateOwner(entry).catch(handleError)
        }
        onDeleteEntry={setEntryToDelete}
      />
      <EntryDeleteDialog
        entry={entryToDelete}
        onOpenChange={(open) => {
          if (!open) setEntryToDelete(null);
        }}
        onDeleteEntry={(entry) => void deleteOwner(entry).catch(handleError)}
      />
    </>
  );
}
