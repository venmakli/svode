import { AttachmentsFolderTable } from "@/features/attachments";
import type { CollectionItemPeekFocus } from "@/features/collection/app-shell";

import { useSkillFilesFolder } from "../hooks/use-skill-files";
import type { AgentContextItem, AgentContextSkillFile } from "../model/types";

/**
 * The skill's «Вложения»: its folder in the Attachments Table. A file opens
 * in the same peek in place of the skill, as items of a collection do.
 */
export function AgentContextSkillFilesTab({
  item,
  onOpenFile,
}: {
  item: AgentContextItem;
  onOpenFile(file: AgentContextSkillFile, focus: CollectionItemPeekFocus): void;
}) {
  const { fileOf, folder } = useSkillFilesFolder(item);

  return (
    <AttachmentsFolderTable
      folder={folder}
      onOpenFile={(attachment, context) => {
        const file = fileOf(attachment);
        if (!file) return;
        onOpenFile(file, {
          fallbackFocus: context.fallbackFocus,
          returnFocus: context.returnFocus,
        });
      }}
    />
  );
}
