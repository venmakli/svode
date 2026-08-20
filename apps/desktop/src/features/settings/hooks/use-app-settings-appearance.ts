import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { isAppLocale, isAppTheme } from "../model";
import { useAppLocale, useAppTheme } from "./use-app-preferences";

export function useAppSettingsAppearance() {
  const {
    locale,
    localePending,
    setLocale: setConfirmedLocale,
  } = useAppLocale();
  const {
    theme,
    themePending,
    setTheme: setConfirmedTheme,
  } = useAppTheme();

  const handleThemeChange = useCallback(
    async (value: string) => {
      if (!isAppTheme(value)) return;
      try {
        await setConfirmedTheme(value);
      } catch (error) {
        console.error("Failed to save app theme:", error);
        toast.error(m.toast_error());
      }
    },
    [setConfirmedTheme],
  );

  const handleLanguageChange = useCallback(
    async (value: string) => {
      if (!isAppLocale(value)) return;
      try {
        await setConfirmedLocale(value);
      } catch (error) {
        console.error("Failed to save app locale:", error);
        toast.error(m.toast_error());
      }
    },
    [setConfirmedLocale],
  );

  return {
    theme,
    themePending,
    locale,
    localePending,
    handleThemeChange,
    handleLanguageChange,
  };
}
