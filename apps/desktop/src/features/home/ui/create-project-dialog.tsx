import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { openDialog } from "@/platform/native/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { FolderOpen } from "lucide-react";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    name: string,
    icon: string,
    description: string | undefined,
    path: string,
  ) => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onSubmit,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C1}");
  const [description, setDescription] = useState("");
  const [folderPath, setFolderPath] = useState("");

  function resetForm() {
    setName("");
    setIcon("\u{1F4C1}");
    setDescription("");
    setFolderPath("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !folderPath.trim()) return;
    onSubmit(
      name.trim(),
      icon,
      description.trim() || undefined,
      folderPath.trim(),
    );
    resetForm();
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  async function handleBrowseFolder() {
    const selected = await openDialog({ directory: true });
    if (selected) {
      setFolderPath(selected);
    }
  }

  const isValid = name.trim() !== "" && folderPath.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.project_new_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Name + icon */}
            <div className="grid gap-2">
              <Label htmlFor="project-name">{m.project_name_label()}</Label>
              <div className="flex gap-2">
                <EmojiPicker value={icon} onChange={setIcon} size="sm" />
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={m.project_name_placeholder()}
                  autoFocus
                />
              </div>
            </div>

            {/* Folder picker */}
            <div className="grid gap-2">
              <Label htmlFor="project-folder">
                {m.project_folder_label()}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="project-folder"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder={m.project_folder_placeholder()}
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
            </div>

            {/* Description */}
            <div className="grid gap-2">
              <Label htmlFor="project-description">
                {m.project_description_label()}
              </Label>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={m.project_description_placeholder()}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {m.project_cancel()}
            </Button>
            <Button type="submit" disabled={!isValid}>
              {m.project_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
