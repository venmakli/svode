import * as m from "@/paraglide/messages.js";
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
import { useCloneProjectDialog } from "../hooks/use-clone-project-dialog";
import type { CloneProjectSubmit } from "../model/root-project";

interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: CloneProjectSubmit;
}

export function CloneProjectDialog({
  open,
  onOpenChange,
  onSubmit,
}: CloneProjectDialogProps) {
  const {
    handleBrowseFolder,
    handleOpenChange,
    handleSubmit,
    isValid,
    repoName,
    setTargetFolder,
    setUrl,
    targetExists,
    targetFolder,
    targetPath,
    trimmedUrl,
    url,
    urlValid,
  } = useCloneProjectDialog({ onOpenChange, onSubmit });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.home_clone_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="clone-url">{m.home_clone_url_label()}</Label>
              <Input
                id="clone-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={m.home_clone_url_placeholder()}
                autoFocus
              />
              {trimmedUrl && !urlValid && (
                <p className="text-xs text-destructive">
                  {m.git_clone_url_invalid()}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="clone-target">
                {m.home_clone_target_label()}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="clone-target"
                  value={targetFolder}
                  onChange={(e) => setTargetFolder(e.target.value)}
                  placeholder={m.home_clone_target_placeholder()}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleBrowseFolder}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              {targetExists ? (
                <p className="text-xs text-destructive">
                  {m.git_clone_folder_exists({ slug: repoName })}
                </p>
              ) : targetPath ? (
                <p className="text-xs text-muted-foreground truncate">
                  → {targetPath}
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {m.home_clone_cancel()}
            </Button>
            <Button type="submit" disabled={!isValid}>
              {m.home_clone_action()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
