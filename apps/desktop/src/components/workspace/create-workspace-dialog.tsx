import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({
  open: isOpen,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const { activeProjectId, createWorkspace } = useWorkspaceStore();
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState("");

  async function handleBrowse() {
    const selected = await open({ directory: true });
    if (selected) {
      setParentDir(selected);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !parentDir.trim() || !activeProjectId) return;
    const fullPath = `${parentDir.replace(/\/+$/, "")}/${name.trim()}`;
    try {
      await createWorkspace(activeProjectId, name.trim(), fullPath);
      onOpenChange(false);
      setName("");
      setParentDir("");
    } catch (err) {
      console.error("Failed to create workspace:", err);
    }
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      setName("");
      setParentDir("");
    }
    onOpenChange(value);
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.workspace_new_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="workspace-name">
                {m.workspace_name_label()}
              </Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={m.workspace_name_placeholder()}
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="workspace-path">
                {m.workspace_path_label()}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="workspace-path"
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                  placeholder={m.workspace_path_placeholder()}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleBrowse}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="sr-only">{m.workspace_browse()}</span>
                </Button>
              </div>
              {parentDir && name.trim() && (
                <p className="text-xs text-muted-foreground truncate">
                  {parentDir.replace(/\/+$/, "")}/{name.trim()}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              {m.project_cancel()}
            </Button>
            <Button type="submit" disabled={!name.trim() || !parentDir.trim()}>
              {m.project_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
