import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  getAppVariables,
  listenAppVariablesChanged,
  removeAppVariable,
  setAppVariableBinding,
  upsertAppVariable,
} from "../api";
import type {
  AppVariableKind,
  AppVariablesCatalog,
  AppVariablesContext,
} from "../model";

export function useAppVariables(context?: AppVariablesContext, notify = true) {
  const [catalog, setCatalog] = useState<AppVariablesCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const next = await getAppVariables(context);
      if (generation === generationRef.current) {
        setCatalog(next);
        setLoadError(false);
      }
      return next;
    } catch (error) {
      if (generation === generationRef.current) setLoadError(true);
      throw error;
    }
  }, [context]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void refresh().catch((error) => {
      if (!disposed && notify) {
        console.error("get_app_variables failed:", error);
        toast.error(m.toast_error());
      }
    });
    void listenAppVariablesChanged(() => {
      if (!disposed) {
        void refresh().catch((error) => {
          console.error("App variables reconciliation failed:", error);
        });
      }
    })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch((error) => {
        console.error("Failed to subscribe to App variable changes:", error);
      });
    return () => {
      disposed = true;
      generationRef.current += 1;
      lifecycleRef.current += 1;
      unlisten?.();
    };
  }, [refresh, notify]);

  const mutate = useCallback(
    async (operation: () => Promise<void>) => {
      if (busyRef.current) return;
      const lifecycle = lifecycleRef.current;
      busyRef.current = true;
      setPending(true);
      try {
        await operation();
        if (lifecycle !== lifecycleRef.current) return;
        await refresh().catch(() => undefined);
        if (notify && lifecycle === lifecycleRef.current)
          toast.success(m.toast_settings_saved());
      } catch (error) {
        if (notify && lifecycle === lifecycleRef.current) {
          console.error("App variable mutation failed:", error);
          toast.error(m.toast_error());
        }
        throw error;
      } finally {
        busyRef.current = false;
        if (lifecycle === lifecycleRef.current) setPending(false);
      }
    },
    [refresh, notify],
  );

  return {
    catalog,
    loadError,
    refresh,
    pending,
    bind: (referenceName: string, entryName: string) => {
      if (!context) return Promise.resolve();
      return mutate(() =>
        setAppVariableBinding({ context, referenceName, entryName }),
      );
    },
    remove: (name: string) => mutate(() => removeAppVariable(name)),
    save: (input: { name: string; kind: AppVariableKind; value?: string }) =>
      mutate(() => upsertAppVariable(input)),
  };
}
