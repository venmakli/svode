import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ThemeProvider } from "@/components/ui/theme-provider";
import {
  getTextDirection,
  setLocale as setParaglideLocale,
} from "@/paraglide/runtime.js";

import {
  getAppPreferences,
  listenAppPreferencesChanged,
  setAppLocale as persistAppLocale,
  setAppTheme as persistAppTheme,
} from "../api";
import {
  isAppTheme,
  normalizeAppLocale,
  normalizeAppTheme,
  type AppLocale,
  type AppTheme,
} from "../model";
import { invalidateAppSettings } from "./use-app-settings";

const LEGACY_THEME_STORAGE_KEY = "svode-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_PREFERENCES: ConfirmedPreferences = {
  locale: "en",
  theme: "system",
};

interface ConfirmedPreferences {
  locale: AppLocale;
  theme: AppTheme;
}

interface AppPreferencesContextValue extends ConfirmedPreferences {
  localePending: boolean;
  setLocale: (locale: AppLocale) => Promise<AppLocale>;
  setTheme: (theme: AppTheme) => Promise<AppTheme>;
  themePending: boolean;
}

const AppPreferencesContext =
  createContext<AppPreferencesContextValue | null>(null);

interface AppPreferencesProviderProps {
  children: ReactNode;
  fallback: ReactNode;
}

export function AppPreferencesProvider({
  children,
  fallback,
}: AppPreferencesProviderProps) {
  const [preferences, setPreferences] =
    useState<ConfirmedPreferences | null>(null);
  const [localePending, setLocalePending] = useState(false);
  const [themePending, setThemePending] = useState(false);
  const preferencesRef = useRef<ConfirmedPreferences | null>(null);
  const mountedRef = useRef(false);
  const localeMutationRef = useRef<Promise<AppLocale> | null>(null);
  const themeMutationRef = useRef<Promise<AppTheme> | null>(null);
  const requestGenerationRef = useRef(0);
  const legacyRecoveryAttemptedRef = useRef(false);

  const applyPreferences = useCallback(
    async (nextPreferences: ConfirmedPreferences) => {
      const currentPreferences = preferencesRef.current;
      if (currentPreferences?.locale !== nextPreferences.locale) {
        await setParaglideLocale(nextPreferences.locale, { reload: false });
      }

      document.documentElement.lang = nextPreferences.locale;
      document.documentElement.dir = getTextDirection(nextPreferences.locale);
      applyThemeToDocument(nextPreferences.theme);

      if (
        currentPreferences?.locale === nextPreferences.locale &&
        currentPreferences.theme === nextPreferences.theme
      ) {
        return currentPreferences;
      }

      preferencesRef.current = nextPreferences;
      setPreferences(nextPreferences);
      return nextPreferences;
    },
    [],
  );

  const readCanonicalPreferences = useCallback(
    async (allowLegacyRecovery: boolean): Promise<ConfirmedPreferences> => {
      const projection = await getAppPreferences();
      let theme = normalizeAppTheme(projection.theme);

      if (!projection.themeNeedsRecovery) {
        clearLegacyTheme();
      } else if (
        allowLegacyRecovery &&
        !legacyRecoveryAttemptedRef.current
      ) {
        legacyRecoveryAttemptedRef.current = true;
        const legacyTheme = readLegacyTheme();
        if (legacyTheme) {
          try {
            theme = await persistAppTheme(legacyTheme);
            clearLegacyTheme();
          } catch (error) {
            console.error("Failed to recover legacy app theme:", error);
          }
        } else {
          clearLegacyTheme();
        }
      }

      return {
        locale: normalizeAppLocale(projection.language),
        theme,
      };
    },
    [],
  );

  const reconcilePreferences = useCallback(
    async (
      fallbackPreferences?: ConfirmedPreferences,
      allowLegacyRecovery = false,
    ): Promise<ConfirmedPreferences> => {
      const generation = ++requestGenerationRef.current;
      let nextPreferences: ConfirmedPreferences;

      try {
        nextPreferences = await readCanonicalPreferences(allowLegacyRecovery);
      } catch (error) {
        if (!fallbackPreferences) throw error;
        nextPreferences = fallbackPreferences;
      }

      if (!mountedRef.current) {
        return preferencesRef.current ?? nextPreferences;
      }
      if (generation !== requestGenerationRef.current) {
        return preferencesRef.current ?? nextPreferences;
      }

      return applyPreferences(nextPreferences);
    },
    [applyPreferences, readCanonicalPreferences],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    mountedRef.current = true;

    const reconcileConfirmedPreferences = () => {
      void reconcilePreferences()
        .then(() => invalidateAppSettings())
        .catch((error) => {
          console.error("Failed to reconcile app preferences:", error);
        });
    };

    const handleFocus = () => reconcileConfirmedPreferences();
    window.addEventListener("focus", handleFocus);

    void listenAppPreferencesChanged(() => {
      if (!disposed) reconcileConfirmedPreferences();
    })
      .then((nextUnlisten) => {
        if (disposed) {
          void nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to app preference changes:", error);
      })
      .finally(() => {
        if (disposed) return;
        void reconcilePreferences(DEFAULT_PREFERENCES, true).catch((error) => {
          console.error("Failed to bootstrap app preferences:", error);
        });
      });

    return () => {
      disposed = true;
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      window.removeEventListener("focus", handleFocus);
      if (unlisten) void unlisten();
    };
  }, [reconcilePreferences]);

  useEffect(() => {
    if (preferences?.theme !== "system" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY);
    const handleSystemThemeChange = () => applyThemeToDocument("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () =>
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [preferences?.theme]);

  const setLocale = useCallback(
    (nextLocale: AppLocale): Promise<AppLocale> => {
      if (nextLocale === preferencesRef.current?.locale) {
        return Promise.resolve(nextLocale);
      }
      if (localeMutationRef.current) return localeMutationRef.current;

      setLocalePending(true);
      const mutationStartGeneration = requestGenerationRef.current;
      const mutation = persistAppLocale(nextLocale)
        .then(async (committedLocale) => {
          const reconciliationStarted =
            requestGenerationRef.current !== mutationStartGeneration;
          try {
            return (await reconcilePreferences()).locale;
          } catch (error) {
            console.error("Failed to re-read committed app locale:", error);
            if (reconciliationStarted) {
              return preferencesRef.current?.locale ?? committedLocale;
            }
            const currentPreferences =
              preferencesRef.current ?? DEFAULT_PREFERENCES;
            return (
              await applyPreferences({
                ...currentPreferences,
                locale: committedLocale,
              })
            ).locale;
          }
        })
        .finally(() => {
          if (localeMutationRef.current === mutation) {
            localeMutationRef.current = null;
            setLocalePending(false);
          }
        });
      localeMutationRef.current = mutation;
      return mutation;
    },
    [applyPreferences, reconcilePreferences],
  );

  const setTheme = useCallback(
    (nextTheme: AppTheme): Promise<AppTheme> => {
      if (nextTheme === preferencesRef.current?.theme) {
        return Promise.resolve(nextTheme);
      }
      if (themeMutationRef.current) return themeMutationRef.current;

      setThemePending(true);
      const mutationStartGeneration = requestGenerationRef.current;
      const mutation = persistAppTheme(nextTheme)
        .then(async (committedTheme) => {
          clearLegacyTheme();
          const reconciliationStarted =
            requestGenerationRef.current !== mutationStartGeneration;
          try {
            return (await reconcilePreferences()).theme;
          } catch (error) {
            console.error("Failed to re-read committed app theme:", error);
            if (reconciliationStarted) {
              return preferencesRef.current?.theme ?? committedTheme;
            }
            const currentPreferences =
              preferencesRef.current ?? DEFAULT_PREFERENCES;
            return (
              await applyPreferences({
                ...currentPreferences,
                theme: committedTheme,
              })
            ).theme;
          }
        })
        .finally(() => {
          if (themeMutationRef.current === mutation) {
            themeMutationRef.current = null;
            setThemePending(false);
          }
        });
      themeMutationRef.current = mutation;
      return mutation;
    },
    [applyPreferences, reconcilePreferences],
  );

  if (!preferences) return fallback;

  const value: AppPreferencesContextValue = {
    ...preferences,
    localePending,
    setLocale,
    setTheme,
    themePending,
  };

  return (
    <AppPreferencesContext.Provider value={value}>
      <ThemeProvider
        theme={preferences.theme}
        setTheme={(nextTheme) => {
          void setTheme(nextTheme).catch((error) => {
            console.error("Failed to set app theme:", error);
          });
        }}
      >
        {children}
      </ThemeProvider>
    </AppPreferencesContext.Provider>
  );
}

export function useAppLocale() {
  const context = useAppPreferencesContext();
  return {
    locale: context.locale,
    localePending: context.localePending,
    setLocale: context.setLocale,
  };
}

export function useAppTheme() {
  const context = useAppPreferencesContext();
  return {
    setTheme: context.setTheme,
    theme: context.theme,
    themePending: context.themePending,
  };
}

function useAppPreferencesContext() {
  const context = useContext(AppPreferencesContext);
  if (!context) {
    throw new Error(
      "App preference hooks must be used within AppPreferencesProvider",
    );
  }
  return context;
}

function applyThemeToDocument(theme: AppTheme) {
  const root = document.documentElement;
  const effectiveTheme =
    theme === "system"
      ? window.matchMedia?.(SYSTEM_THEME_QUERY).matches
        ? "dark"
        : "light"
      : theme;
  root.classList.remove("light", "dark");
  root.classList.add(effectiveTheme);
}

function readLegacyTheme(): AppTheme | null {
  try {
    const value = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    return value && isAppTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function clearLegacyTheme() {
  try {
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in a hardened WebView; canonical preferences remain usable.
  }
}
