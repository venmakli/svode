import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmojiPicker } from "@/components/ui/emoji-picker";
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
  const { activeRootPath, createChild } = useWorkspaceStore();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C2}");

  function resetForm() {
    setName("");
    setIcon("\u{1F4C2}");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !activeRootPath) return;

    try {
      await createChild(activeRootPath, name.trim(), icon);
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

  const isValid = name.trim() !== "";
  const slug = slugPreview(name);
  const projectFolderName = activeRootPath
    ? activeRootPath.split("/").pop() ?? ""
    : "";

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{m.workspace_new_title()}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {m.workspace_add_first_description()}
            </DialogDescription>
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

            {/* Slug preview */}
            {name.trim() && (
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
