import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
} from "@/features/entry/field-save";
import type { Entry } from "@/features/entry";
import { useSpaceTreeSync } from "@/features/space";

export function useEntryPeekFieldSave({
  spacePath,
  projectPath,
  spaceId,
  onEntryChange,
}: {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onEntryChange: Dispatch<SetStateAction<Entry | null>>;
}) {
  const patchEntryTreeMeta = useSpaceTreeSync(
    (state) => state.patchEntryTreeMeta,
  );
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      onEntryChange((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [onEntryChange],
  );

  return useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          updated.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
    },
  });
}
