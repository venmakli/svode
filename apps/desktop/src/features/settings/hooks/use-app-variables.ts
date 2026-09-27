import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useSpace } from "@/features/space";
import {
  getAppVariables,
  listenAppVariablesChanged,
  readVariablesProblem,
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
import {
  ownerKey,
  withOwnerNames,
  type SaveVariableInput,
  type VariableSource,
  type VariableScope,
  type VariableOwner,
  type VariableMutationResult,
  type VariablesProblem,
} from "../model/app-variables";

// The whole catalog, or one owner by `ownerKey`.
export const CATALOG_TARGET = "catalog";
// Result of the last manual reload/recovery of one target. Automatic
// focus/event refreshes never create one.
export type VariablesAttempt = {
  target: string;
  action: "reload" | "recover";
  state: "pending" | "failed" | "finished_unreadable" | "nothing_pending";
};

function readable(catalog: AppVariablesCatalog, target: string) {
  return !catalog.owners.some(
    (item) => item.problem && ownerKey(item.owner) === target,
  );
}

export function useAppVariables(
  context?: AppVariablesContext,
  notify = true,
  enabled = true,
  scope?: VariableScope,
  includeGlobal = false,
) {
  const [catalog, setCatalog] = useState<AppVariablesCatalog | null>(null);
  const ownerNames = useSpace((state) => ({
    rootPath: state.activeRootPath,
    rootName: state.activeRootName,
    spaces: state.spaces,
  }));
  const projectPath = (context ?? scope)?.projectPath;
  const namedCatalog = useMemo(
    () => catalog && withOwnerNames(catalog, projectPath, ownerNames),
    [catalog, projectPath, ownerNames],
  );
  const [problem, setProblem] = useState<VariablesProblem | null>(null);
  const [attempt, setAttempt] = useState<VariablesAttempt | null>(null);
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
        setProblem(null);
        setAttempt((current) =>
          current?.state !== "pending" &&
          (current?.target === CATALOG_TARGET ||
            (current && readable(next, current.target)))
            ? null
            : current,
        );
      }
      return next;
    } catch (error) {
      if (generation === generationRef.current)
        setProblem(readVariablesProblem(error));
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
    setProblem(null);
    setAttempt(null);
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

  // A manual reload or recovery of one target: pending blocks a second run,
  // the result stays next to its cause, and recovery always ends by reading.
  const settle = useCallback(
    async (
      target: string,
      action: VariablesAttempt["action"],
      run: () => Promise<VariableMutationResult & { completed?: boolean }>,
    ) => {
      if (busyRef.current) return;
      const lifecycle = lifecycleRef.current;
      busyRef.current = true;
      setPending(true);
      setAttempt({ target, action, state: "pending" });
      try {
        let completed: boolean | null = null;
        try {
          const result = await run();
          completed = result.completed ?? true;
          if (result.effects.some((e) => e.config.status === "failed"))
            toast.warning(m.app_variables_git_commit_failed());
          if (result.effects.some((e) => e.rootPointer?.status === "failed"))
            toast.warning(m.app_variables_git_pointer_failed());
        } catch {
          completed = null;
        }
        if (lifecycle !== lifecycleRef.current) return;
        const next = await refresh().catch(() => null);
        if (lifecycle !== lifecycleRef.current) return;
        const ok = Boolean(next && readable(next, target));
        const state: VariablesAttempt["state"] | null =
          action === "reload"
            ? ok
              ? null
              : "failed"
            : completed === null
              ? "failed"
              : ok
                ? null
                : completed
                  ? "finished_unreadable"
                  : "nothing_pending";
        setAttempt(state ? { target, action, state } : null);
        if (action === "recover" && completed && ok)
          toast.success(m.variables_recovery_done());
      } finally {
        if (lifecycle === lifecycleRef.current) {
          busyRef.current = false;
          setPending(false);
        }
      }
    },
    [refresh],
  );
  const isBusy = useCallback(() => busyRef.current, []);

  return {
    catalog: namedCatalog,
    problem,
    attempt,
    refresh,
    isBusy,
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
    retry: (target = CATALOG_TARGET) =>
      settle(target, "reload", async () => ({ effects: [] })),
    recover: (source: VariableOwner, target = ownerKey(source)) =>
      settle(target, "recover", () =>
        recoverAppVariables(source, context ?? scope),
      ),
    save: (input: SaveVariableInput) =>
      mutate(() => upsertAppVariable({ ...input, scope: context ?? scope })),
  };
}
