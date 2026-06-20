import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "@/components/ui/theme-provider";
import * as m from "@/paraglide/messages.js";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { getAppSettings, saveAppSettings } from "../api";
import type { AppSettings } from "../model";
import { invalidateAppSettings } from "./use-app-settings";

type AppLocale = "en" | "ru";
type AppTheme = "light" | "dark" | "system";

export function useAppSettingsAppearance(open: boolean) {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [locale, setLocaleState] = useState<AppLocale>(
    getLocale() as AppLocale,
  );

  const loadSettings = useCallback(async () => {
    try {
      const nextSettings = await getAppSettings();
      setSettings(nextSettings);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const preloadSettings = window.setTimeout(() => {
      loadSettings();
      setLocaleState(getLocale() as AppLocale);
    }, 0);
    return () => window.clearTimeout(preloadSettings);
  }, [open, loadSettings]);

  const saveSettings = useCallback(
    async (updated: Partial<AppSettings>) => {
      if (!settings) return false;

      const merged: AppSettings = {
        ...settings,
        appearance: { ...settings.appearance, ...updated.appearance },
        window: { ...settings.window, ...updated.window },
      };

      try {
        await saveAppSettings(merged);
        setSettings(merged);
        invalidateAppSettings();
        return true;
      } catch (err) {
        console.error("Failed to save settings:", err);
        toast.error(m.toast_error());
        return false;
      }
    },
    [settings],
  );

  const handleThemeChange = useCallback(
    async (value: string) => {
      setTheme(value as AppTheme);
      await saveSettings({
        appearance: {
          theme: value,
          language: settings?.appearance.language ?? locale,
        },
      });
    },
    [locale, saveSettings, setTheme, settings?.appearance.language],
  );

  const handleLanguageChange = useCallback(
    async (value: string) => {
      const nextLocale = value as AppLocale;
      setLocale(nextLocale);
      setLocaleState(nextLocale);
      await saveSettings({
        appearance: {
          theme: settings?.appearance.theme ?? "system",
          language: value,
        },
      });
    },
    [saveSettings, settings?.appearance.theme],
  );

  return {
    theme,
    locale,
    handleThemeChange,
    handleLanguageChange,
  };
}
