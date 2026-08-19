import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getTextDirection,
  setLocale as setParaglideLocale,
} from "@/paraglide/runtime.js";

import { getAppSettings, setAppLocale as persistAppLocale } from "../api";
import { normalizeAppLocale, type AppLocale } from "../model";
import { invalidateAppSettings } from "./use-app-settings";

interface AppLocaleContextValue {
  locale: AppLocale;
  localePending: boolean;
  setLocale: (locale: AppLocale) => Promise<AppLocale>;
}

const AppLocaleContext = createContext<AppLocaleContextValue | null>(null);

interface AppLocaleProviderProps {
  children: ReactNode;
  fallback: ReactNode;
}

export function AppLocaleProvider({
  children,
  fallback,
}: AppLocaleProviderProps) {
  const [locale, setActiveLocale] = useState<AppLocale | null>(null);
  const [localePending, setLocalePending] = useState(false);
  const localeRef = useRef<AppLocale | null>(null);
  const pendingMutationRef = useRef<Promise<AppLocale> | null>(null);

  const applyLocale = useCallback(async (nextLocale: AppLocale) => {
    await setParaglideLocale(nextLocale, { reload: false });
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = getTextDirection(nextLocale);
    localeRef.current = nextLocale;
    setActiveLocale(nextLocale);
  }, []);

  useEffect(() => {
    let current = true;

    void getAppSettings()
      .then((settings) => normalizeAppLocale(settings.appearance.language))
      .catch((error) => {
        console.error("Failed to bootstrap app locale:", error);
        return "en" as const;
      })
      .then(async (initialLocale) => {
        await setParaglideLocale(initialLocale, { reload: false });
        if (!current) return;
        document.documentElement.lang = initialLocale;
        document.documentElement.dir = getTextDirection(initialLocale);
        localeRef.current = initialLocale;
        setActiveLocale(initialLocale);
      });

    return () => {
      current = false;
    };
  }, []);

  const setLocale = useCallback(
    (nextLocale: AppLocale): Promise<AppLocale> => {
      if (nextLocale === localeRef.current) {
        return Promise.resolve(nextLocale);
      }
      if (pendingMutationRef.current) {
        return pendingMutationRef.current;
      }

      setLocalePending(true);
      const mutation = persistAppLocale(nextLocale)
        .then(async (committedLocale) => {
          await applyLocale(committedLocale);
          invalidateAppSettings();
          return committedLocale;
        })
        .finally(() => {
          if (pendingMutationRef.current === mutation) {
            pendingMutationRef.current = null;
            setLocalePending(false);
          }
        });
      pendingMutationRef.current = mutation;
      return mutation;
    },
    [applyLocale],
  );

  if (!locale) return fallback;

  const value: AppLocaleContextValue = {
    locale,
    localePending,
    setLocale,
  };

  return (
    <AppLocaleContext.Provider value={value}>
      {children}
    </AppLocaleContext.Provider>
  );
}

export function useAppLocale(): AppLocaleContextValue {
  const context = useContext(AppLocaleContext);
  if (!context) {
    throw new Error("useAppLocale must be used within AppLocaleProvider");
  }
  return context;
}
