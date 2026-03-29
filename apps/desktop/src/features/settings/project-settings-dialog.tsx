import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Plus, Settings } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";
import type { ProjectConfig, Workspace } from "@/types/workspace";
import { CreateWorkspaceDialog } from "@/features/workspace/create-workspace-dialog";

type Section = "general" | "workspaces";

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectSettingsDialog({ open, onOpenChange }: ProjectSettingsDialogProps) {
  const { activeProjectId, activeProjectName, workspaces, loadWorkspaces } = useWorkspaceStore();
  const { openWorkspaceSettings } = useLayoutStore();

  const [section, setSection] = useState<Section>("general");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("\u{1F4CB}");
  const [initialName, setInitialName] = useState("");
  const [initialDescription, setInitialDescription] = useState("");
  const [showUnsaved, setShowUnsaved] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);

  const isDirty = name !== initialName || description !== initialDescription;

  const loadConfig = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const cfg = await invoke<ProjectConfig>("get_project_config_cmd", {
        projectId: activeProjectId,
      });
      setName(cfg.name);
      setDescription(cfg.description);
      setIcon(cfg.icon);
      setInitialName(cfg.name);
      setInitialDescription(cfg.description);
    } catch (err) {
      console.error("Failed to load project config:", err);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (open) {
      loadConfig();
      setSection("general");
    }
  }, [open, loadConfig]);

  async function handleSave() {
    if (!activeProjectId) return;
    try {
      await invoke("save_project_config", {
        projectId: activeProjectId,
        name: name.trim(),
        description: description.trim(),
        icon,
      });
      setInitialName(name.trim());
      setInitialDescription(description.trim());
      // Update store
      useWorkspaceStore.setState({
        activeProjectName: name.trim(),
        activeProjectIcon: icon,
        projects: useWorkspaceStore.getState().projects.map((p) =>
          p.id === activeProjectId
            ? { ...p, name: name.trim(), icon, description: description.trim() }
            : p
        ),
      });
      toast.success(m.toast_settings_saved());
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save project config:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleIconChange(newIcon: string) {
    setIcon(newIcon);
    if (!activeProjectId) return;
    // Auto-save icon
    try {
      await invoke("save_project_config", {
        projectId: activeProjectId,
        name: name.trim() || initialName,
        description: description.trim(),
        icon: newIcon,
      });
      useWorkspaceStore.setState({
        activeProjectIcon: newIcon,
        projects: useWorkspaceStore.getState().projects.map((p) =>
          p.id === activeProjectId ? { ...p, icon: newIcon } : p
        ),
      });
    } catch (err) {
      console.error("Failed to save icon:", err);
    }
  }

  function handleClose() {
    if (isDirty) {
      setShowUnsaved(true);
    } else {
      onOpenChange(false);
    }
  }

  function handleWorkspaceClick(ws: Workspace) {
    onOpenChange(false);
    openWorkspaceSettings(ws.id);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="sm:max-w-[560px] p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle>
              {m.settings_project_title({ name: activeProjectName || "" })}
            </DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex min-h-[320px]">
            {/* Left nav */}
            <nav className="w-[160px] border-r p-2 space-y-1 shrink-0">
              <button
                className={`w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  section === "general" ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSection("general")}
              >
                {m.settings_project_general()}
              </button>
              <button
                className={`w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  section === "workspaces" ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSection("workspaces")}
              >
                {m.settings_project_workspaces()}
              </button>
            </nav>

            {/* Right content */}
            <div className="flex-1 p-6">
              {section === "general" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="project-settings-name">{m.project_name_label()}</Label>
                    <div className="flex gap-2">
                      <EmojiPicker value={icon} onChange={handleIconChange} size="sm" />
                      <Input
                        id="project-settings-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={m.project_name_placeholder()}
                        className="flex-1"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="project-settings-desc">{m.project_description_label()}</Label>
                    <Textarea
                      id="project-settings-desc"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={m.project_description_placeholder()}
                      rows={3}
                    />
                  </div>
                </div>
              )}

              {section === "workspaces" && (
                <div className="space-y-3">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted transition-colors text-left"
                      onClick={() => handleWorkspaceClick(ws)}
                    >
                      <span className="text-lg">{ws.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{ws.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{ws.path}</div>
                      </div>
                      <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setCreateWsOpen(true)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {m.settings_project_add_workspace()}
                  </Button>
                </div>
              )}
            </div>
          </div>
          <Separator />
          <DialogFooter className="px-6 py-4">
            <Button variant="outline" onClick={handleClose}>
              {m.settings_cancel()}
            </Button>
            <Button onClick={handleSave} disabled={!isDirty}>
              {m.settings_save()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateWorkspaceDialog
        open={createWsOpen}
        onOpenChange={setCreateWsOpen}
      />

      <AlertDialog open={showUnsaved} onOpenChange={setShowUnsaved}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.settings_unsaved_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.settings_unsaved_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setShowUnsaved(false);
                setName(initialName);
                setDescription(initialDescription);
                onOpenChange(false);
              }}
            >
              {m.settings_unsaved_discard()}
            </Button>
            <AlertDialogAction onClick={() => {
              setShowUnsaved(false);
              handleSave();
            }}>
              {m.settings_unsaved_save()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
