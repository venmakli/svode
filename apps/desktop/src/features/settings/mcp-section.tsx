import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  installMcpClient,
  getMcpStatus,
  printMcpConfig,
  removeMcpClient,
  runMcpDoctor,
  type McpClientId,
  type McpClientStatus,
  type McpDoctorReport,
  type McpManualConfig,
  type McpStatus,
} from "@/platform/mcp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

function serverBadge(status: McpStatus["server"]["status"]) {
  if (status === "installed") {
    return (
      <Badge variant="secondary">{m.settings_mcp_server_installed()}</Badge>
    );
  }
  if (status === "version_mismatch") {
    return (
      <Badge variant="destructive">
        {m.settings_mcp_server_version_mismatch()}
      </Badge>
    );
  }
  return <Badge variant="outline">{m.settings_mcp_server_not_found()}</Badge>;
}

function clientBadge(client: McpClientStatus) {
  if (client.status === "installed") {
    return (
      <Badge variant="secondary">{m.settings_mcp_client_installed()}</Badge>
    );
  }
  if (client.status === "update_needed") {
    return (
      <Badge variant="destructive">
        {m.settings_mcp_client_update_needed()}
      </Badge>
    );
  }
  if (client.status === "not_found") {
    return <Badge variant="outline">{m.settings_mcp_client_not_found()}</Badge>;
  }
  return (
    <Badge variant="outline">{m.settings_mcp_client_not_installed()}</Badge>
  );
}

function reportLines(report: McpDoctorReport | null) {
  if (!report) return [];
  return [...report.messages, ...report.errors];
}

function StatusPath({ value }: { value: string }) {
  return (
    <p
      className="block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground"
      title={value}
    >
      {value}
    </p>
  );
}

export function McpIntegrationsSection() {
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

  async function handleToggle(client: McpClientStatus, checked: boolean) {
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
  }

  async function handleCopyConfig() {
    try {
      const config: McpManualConfig =
        status?.manualConfig ?? (await printMcpConfig(null));
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      toast.success(m.settings_mcp_config_copied());
    } catch (err) {
      console.error("MCP config copy failed:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDoctor() {
    setLoading(true);
    try {
      setDoctor(await runMcpDoctor());
    } catch (err) {
      console.error("mcp_run_doctor failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-4">
      <Alert className="min-w-0 max-w-full">
        <TriangleAlert data-icon="inline-start" />
        <AlertTitle className="min-w-0">
          {m.settings_mcp_pii_warning_title()}
        </AlertTitle>
        <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
          {m.settings_mcp_pii_warning_description()}
        </AlertDescription>
      </Alert>

      <p className="min-w-0 break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
        {m.settings_mcp_explicit_action_hint()}
      </p>

      <section className="flex min-w-0 max-w-full flex-col gap-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Label className="min-w-0">{m.settings_mcp_server_section()}</Label>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={loadStatus}
            disabled={loading}
          >
            <RefreshCw
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            {m.settings_mcp_refresh()}
          </Button>
        </div>

        <div className="flex w-full min-w-0 max-w-full items-start justify-between gap-3 overflow-hidden rounded-md border p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 text-sm font-medium">combai-mcp</span>
              {status ? serverBadge(status.server.status) : null}
            </div>
            <StatusPath
              value={
                status?.server.command ??
                status?.server.message ??
                m.common_loading()
              }
            />
          </div>
          {status?.server.status === "installed" ? (
            <Check
              className="shrink-0 text-muted-foreground"
              data-icon="inline-end"
            />
          ) : null}
        </div>
      </section>

      <Separator />

      <section className="flex min-w-0 max-w-full flex-col gap-3">
        <Label>{m.settings_mcp_clients_section()}</Label>
        <div className="flex min-w-0 flex-col gap-2">
          {(status?.clients ?? []).map((client) => (
            <div
              key={client.id}
              className="flex w-full min-w-0 max-w-full items-start justify-between gap-3 overflow-hidden rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 text-sm font-medium">
                    {client.name}
                  </span>
                  {clientBadge(client)}
                </div>
                <StatusPath
                  value={client.configPath ?? client.path ?? client.message ?? "—"}
                />
              </div>
              <Switch
                className="shrink-0"
                checked={client.installed}
                disabled={
                  !client.found ||
                  pendingClient === client.id ||
                  status?.server.status !== "installed"
                }
                aria-label={m.settings_mcp_client_toggle({
                  client: client.name,
                })}
                onCheckedChange={(checked) => handleToggle(client, checked)}
              />
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex min-w-0 max-w-full flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Label>{m.settings_mcp_manual_config()}</Label>
            <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {m.settings_mcp_manual_config_description()}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handleCopyConfig}
            disabled={!manualConfigText}
          >
            <Copy data-icon="inline-start" />
            {m.settings_mcp_copy_manual_config()}
          </Button>
        </div>
        <Textarea
          readOnly
          value={manualConfigText}
          className="min-h-32 w-full min-w-0 max-w-full resize-none overflow-x-auto font-mono text-xs"
        />
      </section>

      <section className="flex min-w-0 max-w-full flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Label className="min-w-0">{m.settings_mcp_doctor_section()}</Label>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handleDoctor}
            disabled={loading}
          >
            <Stethoscope data-icon="inline-start" />
            {m.settings_mcp_run_doctor()}
          </Button>
        </div>
        <div className="min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/30 p-3">
          <div className="mb-2">
            {doctor?.ok ? (
              <Badge variant="secondary">{m.settings_mcp_doctor_ok()}</Badge>
            ) : (
              <Badge variant="outline">{m.settings_mcp_doctor_failed()}</Badge>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {reportLines(doctor).map((line) => (
              <p key={line} className="break-all [overflow-wrap:anywhere]">
                {line}
              </p>
            ))}
            {reportLines(doctor).length === 0 ? (
              <p>{m.common_loading()}</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
