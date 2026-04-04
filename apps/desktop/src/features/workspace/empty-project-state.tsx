import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, Plus } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";

export function EmptyProjectState() {
  const { activeProjectId, activeProjectPath, openFolderAsWorkspace } =
    useWorkspaceStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  async function handleOpenFolder() {
    if (!activeProjectId) return;
    const selected = await open({ directory: true });
    if (selected) {
      try {
        await openFolderAsWorkspace(activeProjectId, selected);
      } catch (err) {
        console.error("Failed to open folder as workspace:", err);
      }
    }
  }

  return (
    <>
      <div className="flex h-full flex-col items-center justify-center text-center px-4">
        <p className="text-lg font-medium">{m.workspace_add_first_title()}</p>
        <p className="mt-2 text-sm text-muted-foreground max-w-sm leading-relaxed">
          {m.workspace_add_first_description()}
        </p>
        <div className="mt-6 flex gap-3">
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {m.workspace_create()}
          </Button>
          {!activeProjectPath && (
            <Button variant="outline" onClick={handleOpenFolder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              {m.workspace_open_folder()}
            </Button>
          )}
        </div>
      </div>

      <CreateWorkspaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </>
  );
}
