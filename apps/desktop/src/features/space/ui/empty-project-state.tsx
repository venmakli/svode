import { FilePlus } from "lucide-react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "../model";

/**
 * Shown when a project has no documents and no children.
 */
export function EmptyProjectState() {
  const { activeRootId, activeRootPath, createEntry } = useSpaceStore();
  const { openDocument } = useEntrySelectionStore();

  async function handleCreatePage() {
    if (!activeRootId || !activeRootPath) return;
    try {
      const entry = await createEntry(activeRootPath, m.editor_untitled());
      if (entry) {
        openDocument(entry.path, activeRootId);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilePlus />
        </EmptyMedia>
        <EmptyTitle>{m.project_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.project_empty_description()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={handleCreatePage} disabled={!activeRootPath}>
          <FilePlus data-icon="inline-start" />
          {m.project_empty_create_page()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
