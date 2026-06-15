import { useState, useEffect } from "react";
import { getAppSettings } from "@/platform/settings/settings-api";
import type { AppSettings } from "@/types/space";

let cached: AppSettings | null = null;

export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(cached);

  useEffect(() => {
    if (cached) return;
    getAppSettings()
      .then((s) => {
        cached = s;
        setSettings(s);
      })
      .catch(() => {});
  }, []);

  return settings;
}

export function invalidateAppSettings() {
  cached = null;
}
