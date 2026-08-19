import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  getTextDirection,
  setLocale as setParaglideLocale,
} from "@/paraglide/runtime.js";

import {
  getAppSettings,
  listenAppLocaleChanged,
  setAppLocale as persistAppLocale,
} from "../api";
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
  const mountedRef = useRef(false);
  const pendingMutationRef = useRef<Promise<AppLocale> | null>(null);
  const requestGenerationRef = useRef(0);

  const applyLocale = useCallback(
    async (nextLocale: AppLocale, renderSynchronously = false) => {
      if (localeRef.current === nextLocale) return nextLocale;

      await setParaglideLocale(nextLocale, { reload: false });
      document.documentElement.lang = nextLocale;
      document.documentElement.dir = getTextDirection(nextLocale);
      localeRef.current = nextLocale;
      if (renderSynchronously) {
        flushSync(() => setActiveLocale(nextLocale));
      } else {
        setActiveLocale(nextLocale);
      }
      return nextLocale;
    },
    [],
  );

  const reconcileLocale = useCallback(
    async (
      fallbackLocale?: AppLocale,
      renderSynchronously = false,
    ): Promise<AppLocale> => {
      const generation = ++requestGenerationRef.current;
      let nextLocale: AppLocale;

      try {
        const settings = await getAppSettings();
        nextLocale = normalizeAppLocale(settings.appearance.language);
      } catch (error) {
        if (!fallbackLocale) throw error;
        nextLocale = fallbackLocale;
      }

      if (!mountedRef.current) return localeRef.current ?? nextLocale;

      if (
        generation !== requestGenerationRef.current &&
        localeRef.current !== null
      ) {
        return localeRef.current;
      }

      return applyLocale(nextLocale, renderSynchronously);
    },
    [applyLocale],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    mountedRef.current = true;

    const reconcileConfirmedLocale = () => {
      void reconcileLocale(undefined, true)
        .then(() => invalidateAppSettings())
        .catch((error) => {
          console.error("Failed to reconcile app locale:", error);
        });
    };

    const handleFocus = () => reconcileConfirmedLocale();
    window.addEventListener("focus", handleFocus);

    void listenAppLocaleChanged(() => {
      if (!disposed) reconcileConfirmedLocale();
    })
      .then((nextUnlisten) => {
        if (disposed) {
          void nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to app settings changes:", error);
      })
      .finally(() => {
        if (disposed) return;
        void reconcileLocale("en").catch((error) => {
          console.error("Failed to bootstrap app locale:", error);
        });
      });

    return () => {
      disposed = true;
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      window.removeEventListener("focus", handleFocus);
      if (unlisten) void unlisten();
    };
  }, [reconcileLocale]);

  const setLocale = useCallback(
    (nextLocale: AppLocale): Promise<AppLocale> => {
      if (nextLocale === localeRef.current) {
        return Promise.resolve(nextLocale);
      }
      if (pendingMutationRef.current) {
        return pendingMutationRef.current;
      }

      setLocalePending(true);
      const mutationStartGeneration = requestGenerationRef.current;
      const mutation = persistAppLocale(nextLocale)
        .then(async (committedLocale) => {
          const reconciliationStarted =
            requestGenerationRef.current !== mutationStartGeneration;
          let confirmedLocale: AppLocale;

          try {
            confirmedLocale = await reconcileLocale();
          } catch (error) {
            console.error("Failed to re-read committed app locale:", error);
            confirmedLocale = reconciliationStarted
              ? (localeRef.current ?? committedLocale)
              : await applyLocale(committedLocale);
          }

          invalidateAppSettings();
          return confirmedLocale;
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
    [applyLocale, reconcileLocale],
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
