import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  getMcpStatus,
  installMcpClient,
  listenMcpStatusChanged,
  removeMcpClient,
  removeMcpSharedSkill,
  runMcpDoctor,
  type McpDoctorReport,
  type McpStatus,
} from "../api";
import {
  manualConfigJson,
  operationKey,
  type IntegrationActivity,
  type IntegrationOperation,
} from "../model/svode-integration";

export type { McpDoctorReport, McpStatus } from "../api";

export function useMcpIntegrations() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [doctor, setDoctor] = useState<McpDoctorReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [doctorPending, setDoctorPending] = useState(false);
  const [pending, setPending] = useState<
    ReadonlyMap<string, IntegrationOperation>
  >(() => new Map());
  const [failures, setFailures] = useState<IntegrationActivity["failures"]>({});
  // The set of installed parts changed in this window: open agent sessions
  // get it after a restart.
  const [changed, setChanged] = useState(false);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const doctorRequestGenerationRef = useRef(0);
  const statusFingerprintRef = useRef<string | null>(null);
  const doctorFingerprintRef = useRef<string | null>(null);

  const applyStatus = useCallback(
    (next: McpStatus, generation: number, doctorGeneration: number | null) => {
      if (!mountedRef.current) return;

      if (
        doctorGeneration !== null &&
        doctorGeneration === doctorRequestGenerationRef.current
      ) {
        const nextDoctorFingerprint = JSON.stringify(next.doctor);
        if (doctorFingerprintRef.current !== nextDoctorFingerprint) {
          doctorFingerprintRef.current = nextDoctorFingerprint;
          setDoctor(next.doctor);
        }
      }

      if (generation !== requestGenerationRef.current) return;

      const nextFingerprint = mcpOwnerStatusFingerprint(next);
      if (statusFingerprintRef.current !== nextFingerprint) {
        statusFingerprintRef.current = nextFingerprint;
        setStatus(next);
      }
    },
    [],
  );

  const reconcileStatus = useCallback(
    async (includeDoctor: boolean, showRefreshing = false) => {
      const generation = ++requestGenerationRef.current;
      const doctorGeneration = includeDoctor
        ? ++doctorRequestGenerationRef.current
        : null;
      if (showRefreshing) setRefreshing(true);
      try {
        const next = await getMcpStatus();
        applyStatus(next, generation, doctorGeneration);
        return next;
      } finally {
        if (showRefreshing && mountedRef.current) {
          setRefreshing(false);
        }
      }
    },
    [applyStatus],
  );

  const loadStatus = useCallback(async () => {
    try {
      await reconcileStatus(true, true);
    } catch (err) {
      console.error("mcp_get_status failed:", err);
      toast.error(m.toast_error());
    }
  }, [reconcileStatus]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    mountedRef.current = true;

    const reconcileInBackground = () => {
      void reconcileStatus(false).catch((err) => {
        console.error("MCP status reconciliation failed:", err);
      });
    };
    const handleFocus = () => reconcileInBackground();

    window.addEventListener("focus", handleFocus);
    void listenMcpStatusChanged(() => {
      if (!disposed) reconcileInBackground();
    })
      .then((nextUnlisten) => {
        if (disposed) {
          void nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((err) => {
        console.error("Failed to subscribe to MCP status changes:", err);
      })
      .finally(() => {
        if (disposed) return;
        void reconcileStatus(true).catch((err) => {
          console.error("mcp_get_status failed:", err);
          toast.error(m.toast_error());
        });
      });

    return () => {
      disposed = true;
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      doctorRequestGenerationRef.current += 1;
      window.removeEventListener("focus", handleFocus);
      if (unlisten) void unlisten();
    };
  }, [reconcileStatus]);

  // Runs one operation; the part shows it while it runs and its error after.
  // Resolves to the error message, or null on success.
  const run = useCallback(
    async (operation: IntegrationOperation): Promise<string | null> => {
      const key = operationKey(operation);
      const generation = ++requestGenerationRef.current;
      setPending((current) => new Map(current).set(key, operation));
      setFailures((current) => withoutKey(current, key));
      try {
        const next =
          operation.kind === "install"
            ? await installMcpClient(operation.client)
            : operation.kind === "remove"
              ? await removeMcpClient(operation.client)
              : await removeMcpSharedSkill();
        applyStatus(next, generation, null);
        if (mountedRef.current) setChanged(true);
        return null;
      } catch (err) {
        console.error("Svode integration operation failed:", err);
        const message = errorMessage(err);
        if (mountedRef.current)
          setFailures((current) => ({
            ...current,
            [key]: { operation, message },
          }));
        try {
          await reconcileStatus(false);
        } catch (reconcileError) {
          console.error(
            "Failed to reconcile MCP status after an operation error:",
            reconcileError,
          );
        }
        return message;
      } finally {
        if (mountedRef.current)
          setPending((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
          });
      }
    },
    [applyStatus, reconcileStatus],
  );

  const handleCopyConfig = useCallback(async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(
        manualConfigJson(status.manualConfig),
      );
      toast.success(m.settings_mcp_config_copied());
    } catch (err) {
      console.error("MCP config copy failed:", err);
      toast.error(m.toast_error());
    }
  }, [status]);

  const handleDoctor = useCallback(async () => {
    const generation = ++doctorRequestGenerationRef.current;
    setDoctorPending(true);
    try {
      const nextDoctor = await runMcpDoctor();
      if (
        mountedRef.current &&
        generation === doctorRequestGenerationRef.current
      ) {
        doctorFingerprintRef.current = JSON.stringify(nextDoctor);
        setDoctor(nextDoctor);
      }
    } catch (err) {
      console.error("mcp_run_doctor failed:", err);
      toast.error(m.toast_error());
    } finally {
      if (
        mountedRef.current &&
        generation === doctorRequestGenerationRef.current
      ) {
        setDoctorPending(false);
      }
    }
  }, []);

  return {
    status,
    doctor,
    refreshing,
    doctorPending,
    activity: { pending, failures } satisfies IntegrationActivity,
    changed,
    loadStatus,
    run,
    handleCopyConfig,
    handleDoctor,
  };
}

function mcpOwnerStatusFingerprint(status: McpStatus): string {
  return JSON.stringify({
    server: status.server,
    clients: status.clients,
    sharedSkill: status.sharedSkill,
    manualConfig: status.manualConfig,
    runtimeUpdatedFrom: status.runtimeUpdatedFrom,
  });
}

function withoutKey<T>(
  current: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string") return message;
  }
  return String(error);
}
