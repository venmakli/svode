import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types/workspace";

let cached: AppSettings | null = null;

export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(cached);

  useEffect(() => {
    if (cached) return;
    invoke<AppSettings>("get_app_settings")
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
