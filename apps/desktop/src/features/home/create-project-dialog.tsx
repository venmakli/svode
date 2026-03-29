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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
    description?: string,
    variant?: string,
    path?: string,
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
  const [variant, setVariant] = useState<"lightweight" | "directory">(
    "lightweight",
  );
  const [folderPath, setFolderPath] = useState("");

  function resetForm() {
    setName("");
    setIcon("\u{1F4C1}");
    setDescription("");
    setVariant("lightweight");
    setFolderPath("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (variant === "directory" && !folderPath.trim()) return;
    onSubmit(
      name.trim(),
      icon,
      description.trim() || undefined,
      variant,
      variant === "directory" ? folderPath.trim() : undefined,
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

  const isValid =
    name.trim() !== "" &&
    (variant === "lightweight" || folderPath.trim() !== "");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.project_new_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Variant selector */}
            <div className="grid gap-2">
              <Label>{m.project_variant_label()}</Label>
              <RadioGroup
                value={variant}
                onValueChange={(v) =>
                  setVariant(v as "lightweight" | "directory")
                }
                className="gap-3"
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <RadioGroupItem value="lightweight" className="mt-0.5" />
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium leading-none">
                      {m.project_variant_lightweight()}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {m.project_variant_lightweight_desc()}
                    </span>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <RadioGroupItem value="directory" className="mt-0.5" />
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium leading-none">
                      {m.project_variant_directory()}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {m.project_variant_directory_desc()}
                    </span>
                  </div>
                </label>
              </RadioGroup>
            </div>

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

            {/* Folder picker (Directory variant only) */}
            {variant === "directory" && (
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
            )}
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
