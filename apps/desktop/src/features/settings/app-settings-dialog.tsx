import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { setLocale, getLocale } from "@/paraglide/runtime.js";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/components/ui/theme-provider";
import type { AppSettings } from "@/types/workspace";

const AVATAR_COLORS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#06B6D4", "#F97316", "#6366F1", "#14B8A6",
];

type Section = "profile" | "appearance";

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppSettingsDialog({ open, onOpenChange }: AppSettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<Section>("profile");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("#3B82F6");
  const [initialName, setInitialName] = useState("");
  const [showUnsaved, setShowUnsaved] = useState(false);

  const isDirty = name !== initialName;

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<AppSettings>("get_app_settings");
      setSettings(s);
      setName(s.user.name);
      setAvatar(s.user.avatar);
      setInitialName(s.user.name);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadSettings();
      setSection("profile");
    }
  }, [open, loadSettings]);

  async function saveSettings(updated: Partial<AppSettings>) {
    if (!settings) return;
    const merged: AppSettings = {
      ...settings,
      user: { ...settings.user, ...updated.user },
      appearance: { ...settings.appearance, ...updated.appearance },
      window: { ...settings.window, ...updated.window },
    };
    try {
      await invoke("save_app_settings", { settingsData: merged });
      setSettings(merged);
      return true;
    } catch (err) {
      console.error("Failed to save settings:", err);
      toast.error(m.toast_error());
      return false;
    }
  }

  async function handleSave() {
    const ok = await saveSettings({ user: { name, avatar } });
    if (ok) {
      setInitialName(name);
      toast.success(m.toast_settings_saved());
      onOpenChange(false);
    }
  }

  function handleClose() {
    if (isDirty) {
      setShowUnsaved(true);
    } else {
      onOpenChange(false);
    }
  }

  async function handleThemeChange(value: string) {
    setTheme(value as "light" | "dark" | "system");
    await saveSettings({ appearance: { theme: value, language: settings?.appearance.language ?? "en" } });
  }

  async function handleLanguageChange(value: string) {
    setLocale(value as "en" | "ru");
    await saveSettings({ appearance: { theme: settings?.appearance.theme ?? "system", language: value } });
  }

  async function handleAvatarChange(color: string) {
    setAvatar(color);
    await saveSettings({ user: { name, avatar: color } });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="sm:max-w-[560px] p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle>{m.settings_title()}</DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex min-h-[320px]">
            {/* Left nav */}
            <nav className="w-[160px] border-r p-2 space-y-1 shrink-0">
              <button
                className={`w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  section === "profile" ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSection("profile")}
              >
                {m.settings_profile()}
              </button>
              <button
                className={`w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  section === "appearance" ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setSection("appearance")}
              >
                {m.settings_appearance()}
              </button>
            </nav>

            {/* Right content */}
            <div className="flex-1 p-6">
              {section === "profile" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="settings-name">{m.settings_profile_name()}</Label>
                    <Input
                      id="settings-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={m.settings_profile_name_placeholder()}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{m.settings_profile_avatar()}</Label>
                    <div className="flex gap-2 flex-wrap">
                      {AVATAR_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`w-8 h-8 rounded-md transition-all ${
                            avatar === color ? "ring-2 ring-offset-2 ring-primary" : ""
                          }`}
                          style={{ backgroundColor: color }}
                          onClick={() => handleAvatarChange(color)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {section === "appearance" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>{m.settings_theme_label()}</Label>
                    <RadioGroup
                      value={theme}
                      onValueChange={handleThemeChange}
                      className="flex gap-4"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="system" />
                        <span className="text-sm">{m.common_theme_system()}</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="light" />
                        <span className="text-sm">{m.common_theme_light()}</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="dark" />
                        <span className="text-sm">{m.common_theme_dark()}</span>
                      </label>
                    </RadioGroup>
                  </div>
                  <div className="space-y-2">
                    <Label>{m.settings_language_label()}</Label>
                    <Select
                      value={getLocale()}
                      onValueChange={handleLanguageChange}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">{m.settings_language_en()}</SelectItem>
                        <SelectItem value="ru">{m.settings_language_ru()}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
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

      <AlertDialog open={showUnsaved} onOpenChange={setShowUnsaved}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.settings_unsaved_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.settings_unsaved_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowUnsaved(false)}>
              {m.settings_cancel()}
            </AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setShowUnsaved(false);
                setName(initialName);
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
