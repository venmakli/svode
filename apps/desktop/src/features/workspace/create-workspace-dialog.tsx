import { useEffect, useState } from "react";
import * as m from "@/paraglide/messages.js";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { useGitStore } from "@/stores/git";
import type { CloneProgress } from "@/types/git";

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

// Accepts: https://, http://, git@host:..., ssh://, file:// (relative paths
// rejected because clone needs an unambiguous remote location).
const URL_REGEX =
  /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)\S+|^[\w.-]+@[\w.-]+:\S+$/;

export function CreateWorkspaceDialog({
  open: isOpen,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const { activeRootPath, createChild, loadChildren } = useWorkspaceStore();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("\u{1F4C2}");
  const [url, setUrl] = useState("");
  const [slugCollision, setSlugCollision] = useState(false);

  function resetForm() {
    setName("");
    setIcon("\u{1F4C2}");
    setUrl("");
    setSlugCollision(false);
  }

  const slug = slugPreview(name);
  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl === "" || URL_REGEX.test(trimmedUrl);
  const targetPath =
    activeRootPath && slug ? `${activeRootPath}/${slug}` : null;

  // Debounced slug-collision check — disables submit if target folder exists.
  useEffect(() => {
    if (!targetPath || !name.trim()) {
      setSlugCollision(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await invoke<boolean>("path_exists", {
          path: targetPath,
        });
        if (!cancelled) setSlugCollision(exists);
      } catch {
        if (!cancelled) setSlugCollision(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetPath, name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !activeRootPath || !urlValid) return;

    if (trimmedUrl === "") {
      // No URL → create a new workspace + git init
      try {
        const ws = await createChild(activeRootPath, name.trim(), icon);
        try {
          await invoke("git_init_workspace", { workspacePath: ws.path });
        } catch (err) {
          console.warn("git_init_workspace failed:", err);
        }
        onOpenChange(false);
        resetForm();
      } catch (err) {
        console.error("Failed to create workspace:", err);
        toast.error(m.toast_error());
      }
      return;
    }

    // Clone path — non-blocking. Close the dialog immediately and let the
    // sidebar render an inline progress indicator.
    if (!targetPath) return;
    onOpenChange(false);
    void runClone({
      url: trimmedUrl,
      targetPath,
      parentPath: activeRootPath,
      folderName: slug,
      fallbackName: name.trim(),
      icon,
    });
    resetForm();
  }

  async function runClone(opts: {
    url: string;
    targetPath: string;
    parentPath: string;
    folderName: string;
    fallbackName: string;
    icon: string;
  }) {
    const git = useGitStore.getState();
    git.setCloning(opts.targetPath, { phase: "Starting", percent: 0 });

    // Listen for progress events for this specific target path
    const unlisten = await listen<CloneProgress>(
      "clone:progress",
      (event) => {
        if (event.payload.workspacePath !== opts.targetPath) return;
        useGitStore.getState().setCloning(opts.targetPath, {
          phase: event.payload.phase,
          percent: event.payload.percent,
        });
      },
    );

    try {
      await invoke("git_clone_workspace", {
        url: opts.url,
        targetPath: opts.targetPath,
      });
      // Register the cloned folder as a child workspace. Backend scaffolds
      // `.combai/` if the repo didn't ship one, then adds a ChildRef entry
      // to the parent's config.json.
      await invoke("register_cloned_child", {
        parentPath: opts.parentPath,
        folderName: opts.folderName,
        fallbackName: opts.fallbackName,
        icon: opts.icon,
      });
      await loadChildren(opts.parentPath);
      git.setCloning(opts.targetPath, null);
    } catch (err) {
      console.error("git_clone_workspace failed:", err);
      const message =
        typeof err === "string" ? err : (err as Error)?.message ?? "error";
      git.setCloning(opts.targetPath, {
        phase: m.git_clone_failed(),
        percent: 0,
        error: message,
      });
      toast.error(m.git_clone_failed());
      // Auto-clear the ✕ state after a few seconds so the sidebar row
      // isn't stuck forever. User already saw the toast + indicator.
      window.setTimeout(() => {
        useGitStore.getState().setCloning(opts.targetPath, null);
      }, 6000);
    } finally {
      unlisten();
    }
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  const isValid = name.trim() !== "" && urlValid && !slugCollision;
  const projectFolderName = activeRootPath
    ? activeRootPath.split("/").pop() ?? ""
    : "";
  const submitLabel = trimmedUrl ? m.git_clone_action() : m.project_create();

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
            {slugCollision && (
              <p className="text-xs text-destructive">
                {m.git_clone_folder_exists({ slug })}
              </p>
            )}

            {/* Optional clone URL */}
            <div className="grid gap-2">
              <Label htmlFor="workspace-url">{m.git_clone_url_label()}</Label>
              <Input
                id="workspace-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
              {!urlValid && (
                <p className="text-xs text-destructive">
                  {m.git_clone_url_invalid()}
                </p>
              )}
              {urlValid && (
                <p className="text-xs text-muted-foreground">
                  {m.git_clone_url_hint()}
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
              {m.project_cancel()}
            </Button>
            <Button type="submit" disabled={!isValid}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
