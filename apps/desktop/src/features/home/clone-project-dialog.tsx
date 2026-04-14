import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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

interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (url: string, targetPath: string) => void;
}

const URL_REGEX =
  /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)\S+|^[\w.-]+@[\w.-]+:\S+$/;

export function CloneProjectDialog({
  open,
  onOpenChange,
  onSubmit,
}: CloneProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [targetFolder, setTargetFolder] = useState("");

  function resetForm() {
    setUrl("");
    setTargetFolder("");
  }

  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl !== "" && URL_REGEX.test(trimmedUrl);
  const repoName = trimmedUrl.split("/").pop()?.replace(/\.git$/, "") || "";
  const targetPath = targetFolder && repoName ? `${targetFolder}/${repoName}` : "";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!urlValid || !targetFolder.trim()) return;
    onSubmit(trimmedUrl, targetPath);
    resetForm();
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  async function handleBrowseFolder() {
    const selected = await openDialog({ directory: true });
    if (selected) {
      setTargetFolder(selected);
    }
  }

  const isValid = urlValid && targetFolder.trim() !== "";

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
              <Label htmlFor="clone-target">{m.home_clone_target_label()}</Label>
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
              {targetPath && (
                <p className="text-xs text-muted-foreground truncate">
                  → {targetPath}
                </p>
              )}
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
