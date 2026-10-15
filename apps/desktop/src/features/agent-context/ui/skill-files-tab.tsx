import { AttachmentsFolderTable } from "@/features/attachments";
import { useCollectionDetailController } from "@/features/collection/app-shell";

import { useSkillFilesFolder } from "../hooks/use-skill-files";
import type { AgentContextItem } from "../model/types";
import { createSkillFileDetailContent } from "./skill-file-detail";

/**
 * The skill's «Вложения»: its folder in the Attachments Table. A file opens
 * in the same peek in place of the skill, as rows of a collection do.
 */
export function AgentContextSkillFilesTab({
  item,
}: {
  item: AgentContextItem;
}) {
  const controller = useCollectionDetailController();
  const { fileOf, folder } = useSkillFilesFolder(item);

  return (
    <AttachmentsFolderTable
      folder={folder}
      onOpenFile={(row, context) => {
        const file = fileOf(row);
        if (!file) return;
        const selection = {
          instanceKey: `agent-context-skill:${item.id}`,
          presentationId: "files",
          rowId: file.path,
        };
        void controller.open(
          {
            ...createSkillFileDetailContent({
              file,
              item,
              onClose: () => void controller.close(selection),
            }),
            selection,
          },
          {
            fallbackFocus: context.fallbackFocus,
            returnFocus: context.returnFocus,
          },
        );
      }}
    />
  );
}
