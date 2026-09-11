import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  getAppVariables,
  listenAppVariablesChanged,
  removeAppVariable,
  recoverAppVariables,
  setAppVariableBinding,
  upsertAppVariable,
} from "../api";
import type {
  AppVariableEntry,
  AppVariablesCatalog,
  AppVariablesContext,
} from "../model";
import type {
  SaveVariableInput,
  VariableSource,
  VariableScope,
  VariableOwner,
  VariableMutationResult,
} from "../model/app-variables";

export function useAppVariables(
  context?: AppVariablesContext,
  notify = true,
  enabled = true,
  scope?: VariableScope,
  includeGlobal = false,
) {
  const [catalog, setCatalog] = useState<AppVariablesCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const next = await getAppVariables(context, scope, includeGlobal);
      if (generation === generationRef.current) {
        setCatalog(next);
        setLoadError(false);
      }
      return next;
    } catch (error) {
      if (generation === generationRef.current) setLoadError(true);
      throw error;
    }
  }, [context, scope, includeGlobal]);

  useEffect(() => {
    busyRef.current = false;
    setPending(false);
    if (!enabled) {
      setCatalog(null);
      return;
    }
    setCatalog(null);
    setLoadError(false);
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
    const reconcile = () => {
      if (!disposed) void refresh().catch(() => undefined);
    };
    window.addEventListener("focus", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      disposed = true;
      generationRef.current += 1;
      lifecycleRef.current += 1;
      unlisten?.();
    };
  }, [refresh, notify, enabled]);

  const mutate = useCallback(
    async (operation: () => Promise<void | VariableMutationResult>) => {
      if (busyRef.current) return;
      const lifecycle = lifecycleRef.current;
      busyRef.current = true;
      setPending(true);
      try {
        const result = await operation();
        if (lifecycle !== lifecycleRef.current) return result;
        await refresh().catch(() => undefined);
        if (lifecycle !== lifecycleRef.current) return result;
        const configFailed = result?.effects.some(
          (effect) => effect.config.status === "failed",
        );
        const pointerFailed = result?.effects.some(
          (effect) => effect.rootPointer?.status === "failed",
        );
        if (configFailed) toast.warning(m.app_variables_git_commit_failed());
        if (pointerFailed) toast.warning(m.app_variables_git_pointer_failed());
        if (result?.recoveryError) {
          if (!notify) toast.error(m.app_variables_recovery_failed());
          throw new Error(result.recoveryError);
        }
        if (notify && !configFailed && !pointerFailed)
          toast.success(m.toast_settings_saved());
        return result;
      } catch (error) {
        if (notify && lifecycle === lifecycleRef.current) {
          console.error("App variable mutation failed:", error);
          toast.error(m.toast_error());
        }
        throw error;
      } finally {
        if (lifecycle === lifecycleRef.current) {
          busyRef.current = false;
          setPending(false);
        }
      }
    },
    [refresh, notify],
  );

  return {
    catalog,
    loadError,
    refresh,
    pending,
    bind: (
      referenceName: string,
      source: VariableSource | null,
      revision: string,
    ) => {
      if (!context) return Promise.resolve();
      return mutate(() =>
        setAppVariableBinding({ context, referenceName, source, revision }),
      );
    },
    remove: (entry: AppVariableEntry) =>
      mutate(() =>
        removeAppVariable({
          scope: context ?? scope,
          source: entry.source,
          revision: entry.revision,
        }),
      ),
    recover: (source?: VariableOwner) =>
      mutate(() => recoverAppVariables(source, context ?? scope)),
    save: (input: SaveVariableInput) =>
      mutate(() => upsertAppVariable({ ...input, scope: context ?? scope })),
  };
}
