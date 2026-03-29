import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
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
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { FolderOpen } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CYRILLIC_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
  з: "z", и: "i", й: "j", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya",
};

/** Slug preview matching Rust slugify logic (transliterate + kebab-case). */
function slugPreview(name: string): string {
  const transliterated = name
    .toLowerCase()
    .split("")
    .map((c) => CYRILLIC_MAP[c] ?? c)
    .join("");
  return transliterated
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "untitled";
}

export function CreateWorkspaceDialog({
  open: isOpen,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const {
    activeProjectId,
    activeProjectVariant,
    activeProjectPath,
    createWorkspace,
    createWorkspaceInDirectory,
  } = useWorkspaceStore();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C2}");
  const [folderPath, setFolderPath] = useState("");

  const isDirectory = activeProjectVariant === "directory";

  function resetForm() {
    setName("");
    setIcon("\u{1F4C2}");
    setFolderPath("");
  }

  async function handleBrowse() {
    const selected = await open({ directory: true });
    if (selected) {
      setFolderPath(selected);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !activeProjectId) return;

    try {
      if (isDirectory) {
        await createWorkspaceInDirectory(activeProjectId, name.trim(), icon);
      } else {
        if (!folderPath.trim()) return;
        await createWorkspace(activeProjectId, name.trim(), folderPath.trim());
      }
      onOpenChange(false);
      resetForm();
    } catch (err) {
      console.error("Failed to create workspace:", err);
      toast.error(m.toast_error());
    }
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  const isValid = name.trim() !== "" && (isDirectory || folderPath.trim() !== "");

  // Build slug preview path for directory mode
  const slug = slugPreview(name);
  const projectFolderName = activeProjectPath
    ? activeProjectPath.split("/").pop() ?? ""
    : "";

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.workspace_new_title()}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Name + icon */}
            <div className="grid gap-2">
              <Label htmlFor="workspace-name">
                {m.workspace_name_label()}
              </Label>
              <div className="flex gap-2">
                <EmojiPicker value={icon} onChange={setIcon} size="sm" />
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={m.workspace_name_placeholder()}
                  autoFocus
                />
              </div>
            </div>

            {/* Lightweight: folder picker for existing directory */}
            {!isDirectory && (
              <div className="grid gap-2">
                <Label htmlFor="workspace-path">
                  {m.workspace_path_label()}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="workspace-path"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
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
              </div>
            )}

            {/* Directory: slug preview */}
            {isDirectory && name.trim() && (
              <p className="text-xs text-muted-foreground">
                {m.workspace_slug_preview({
                  path: `${projectFolderName}/${slug}/`,
                })}
              </p>
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
