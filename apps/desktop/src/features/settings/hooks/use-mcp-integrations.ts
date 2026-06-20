import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  getMcpStatus,
  installMcpClient,
  printMcpConfig,
  removeMcpClient,
  runMcpDoctor,
  type McpClientId,
  type McpClientStatus,
  type McpDoctorReport,
  type McpManualConfig,
  type McpStatus,
} from "../api";

export type {
  McpClientStatus,
  McpDoctorReport,
  McpStatus,
} from "../api";

export function useMcpIntegrations() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [doctor, setDoctor] = useState<McpDoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingClient, setPendingClient] = useState<McpClientId | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getMcpStatus();
      setStatus(next);
      setDoctor(next.doctor);
    } catch (err) {
      console.error("mcp_get_status failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const manualConfigText = useMemo(() => {
    const config = status?.manualConfig;
    if (!config) return "";
    return JSON.stringify(config, null, 2);
  }, [status]);

  const handleToggle = useCallback(
    async (client: McpClientStatus, checked: boolean) => {
      setPendingClient(client.id);
      try {
        const next = checked
          ? await installMcpClient(client.id)
          : await removeMcpClient(client.id);
        setStatus(next);
        setDoctor(next.doctor);
        toast.success(m.toast_settings_saved());
      } catch (err) {
        console.error("MCP client toggle failed:", err);
        toast.error(m.toast_error());
      } finally {
        setPendingClient(null);
      }
    },
    [],
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
    setLoading(true);
    try {
      setDoctor(await runMcpDoctor());
    } catch (err) {
      console.error("mcp_run_doctor failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    status,
    doctor,
    loading,
    pendingClient,
    manualConfigText,
    loadStatus,
    handleToggle,
    handleCopyConfig,
    handleDoctor,
  };
}
