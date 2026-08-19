import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "@/components/ui/theme-provider";
import * as m from "@/paraglide/messages.js";
import { getAppSettings, saveAppSettings } from "../api";
import { isAppLocale, type AppSettings } from "../model";
import { useAppLocale } from "./use-app-locale";
import { invalidateAppSettings } from "./use-app-settings";

type AppTheme = "light" | "dark" | "system";

export function useAppSettingsAppearance(open: boolean) {
  const { theme, setTheme } = useTheme();
  const {
    locale,
    localePending,
    setLocale: setConfirmedLocale,
  } = useAppLocale();
  const [settings, setSettings] = useState<AppSettings | null>(null);

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
      if (!isAppLocale(value)) return;
      try {
        const committedLocale = await setConfirmedLocale(value);
        setSettings((current) =>
          current
            ? {
                ...current,
                appearance: {
                  ...current.appearance,
                  language: committedLocale,
                },
              }
            : current,
        );
      } catch (err) {
        console.error("Failed to save app locale:", err);
        toast.error(m.toast_error());
      }
    },
    [setConfirmedLocale],
  );

  return {
    theme,
    locale,
    localePending,
    handleThemeChange,
    handleLanguageChange,
  };
}
