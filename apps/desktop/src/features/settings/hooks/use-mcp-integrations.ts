import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  getMcpStatus,
  installMcpClient,
  listenMcpStatusChanged,
  printMcpConfig,
  removeMcpClient,
  runMcpDoctor,
  type McpClientId,
  type McpClientStatus,
  type McpDoctorReport,
  type McpManualConfig,
  type McpStatus,
} from "../api";

export type { McpClientStatus, McpDoctorReport, McpStatus } from "../api";

export function useMcpIntegrations() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [doctor, setDoctor] = useState<McpDoctorReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [doctorPending, setDoctorPending] = useState(false);
  const [pendingClients, setPendingClients] = useState<
    ReadonlySet<McpClientId>
  >(() => new Set());
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

  const manualConfigText = useMemo(() => {
    const config = status?.manualConfig;
    if (!config) return "";
    return JSON.stringify(config, null, 2);
  }, [status]);

  const handleToggle = useCallback(
    async (client: McpClientStatus, checked: boolean) => {
      const generation = ++requestGenerationRef.current;
      setPendingClients((current) => addPendingClient(current, client.id));
      try {
        const next = checked
          ? await installMcpClient(client.id)
          : await removeMcpClient(client.id);
        applyStatus(next, generation, null);
        toast.success(m.toast_settings_saved());
      } catch (err) {
        console.error("MCP client toggle failed:", err);
        try {
          await reconcileStatus(false);
        } catch (reconcileError) {
          console.error(
            "Failed to reconcile MCP status after toggle error:",
            reconcileError,
          );
        }
        toast.error(m.toast_error());
      } finally {
        setPendingClients((current) => removePendingClient(current, client.id));
      }
    },
    [applyStatus, reconcileStatus],
  );

  const handleCopyConfig = useCallback(async () => {
    try {
      const config: McpManualConfig =
        status?.manualConfig ?? (await printMcpConfig(null));
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
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
    pendingClients,
    manualConfigText,
    loadStatus,
    handleToggle,
    handleCopyConfig,
    handleDoctor,
  };
}

function mcpOwnerStatusFingerprint(status: McpStatus): string {
  return JSON.stringify({
    server: status.server,
    clients: status.clients,
    manualConfig: status.manualConfig,
  });
}

function addPendingClient(
  current: ReadonlySet<McpClientId>,
  client: McpClientId,
): ReadonlySet<McpClientId> {
  if (current.has(client)) return current;
  return new Set([...current, client]);
}

function removePendingClient(
  current: ReadonlySet<McpClientId>,
  client: McpClientId,
): ReadonlySet<McpClientId> {
  if (!current.has(client)) return current;
  const next = new Set(current);
  next.delete(client);
  return next;
}
