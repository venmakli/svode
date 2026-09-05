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

export function useAppVariables(context?: AppVariablesContext) {
  const [catalog, setCatalog] = useState<AppVariablesCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const next = await getAppVariables(context);
    if (generation === generationRef.current) setCatalog(next);
    return next;
  }, [context]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void refresh().catch((error) => {
      console.error("get_app_variables failed:", error);
      toast.error(m.toast_error());
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
      unlisten?.();
    };
  }, [refresh]);

  const mutate = useCallback(
    async (operation: () => Promise<void>) => {
      setPending(true);
      try {
        await operation();
        await refresh();
        toast.success(m.toast_settings_saved());
      } catch (error) {
        console.error("App variable mutation failed:", error);
        toast.error(m.toast_error());
        throw error;
      } finally {
        setPending(false);
      }
    },
    [refresh],
  );

  return {
    catalog,
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
