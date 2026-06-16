import { useState, useEffect } from "react";
import { getAppSettings } from "../api";
import type { AppSettings } from "../model";

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
