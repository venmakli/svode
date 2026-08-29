import {
  Check,
  Copy,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  type McpClientStatus,
  type McpDoctorReport,
  type McpStatus,
  useMcpIntegrations,
} from "../hooks/use-mcp-integrations";
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
  return <Badge variant="outline">{m.settings_mcp_server_not_found()}</Badge>;
}

function clientBadge(client: McpClientStatus) {
  if (client.status === "installed") {
    return (
      <Badge variant="secondary">{m.settings_mcp_client_installed()}</Badge>
    );
  }
  if (client.status === "attention") {
    return (
      <Badge variant="destructive">
        {m.settings_mcp_client_attention()}
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

function clientDetail(client: McpClientStatus) {
  switch (client.attentionCode) {
    case "bridge_incompatible":
      return m.settings_mcp_client_bridge_incompatible();
    case "bridge_missing":
      return m.settings_mcp_client_bridge_missing();
    case "config_unreadable":
      return m.settings_mcp_client_config_unreadable();
    case "custom_conflict":
      return m.settings_mcp_client_custom_conflict();
    case "higher_precedence_conflict":
      return m.settings_mcp_client_higher_precedence_conflict();
    case "repair_failed":
      return m.settings_mcp_client_repair_failed();
    default:
      return client.status === "not_found"
        ? m.settings_mcp_client_unavailable()
        : null;
  }
}

function blocksManagedToggle(client: McpClientStatus) {
  return (
    client.attentionCode === "config_unreadable" ||
    client.attentionCode === "custom_conflict" ||
    client.attentionCode === "higher_precedence_conflict"
  );
}

function reportLines(report: McpDoctorReport | null) {
  if (!report) return [];
  return [...report.messages, ...report.errors];
}

function StatusPath({ value }: { value: string }) {
  return (
    <p
      className="block w-full min-w-0 max-w-full truncate text-xs text-muted-foreground"
      title={value}
    >
      {value}
    </p>
  );
}

export function McpIntegrationsSection() {
  const {
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
  } = useMcpIntegrations();

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
            disabled={refreshing}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? "animate-spin" : undefined}
            />
            {m.settings_mcp_refresh()}
          </Button>
        </div>

        <div className="flex w-full min-w-0 max-w-full items-start justify-between gap-3 overflow-hidden rounded-md border p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 text-sm font-medium">svode-mcp</span>
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
              data-mcp-client={client.id}
              className="flex w-full min-w-0 max-w-full items-start justify-between gap-3 overflow-hidden rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 text-sm font-medium">
                    {client.name}
                  </span>
                  {clientBadge(client)}
                </div>
                {clientDetail(client) ? (
                  <p className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {clientDetail(client)}
                  </p>
                ) : null}
              </div>
              <Switch
                className="shrink-0"
                checked={client.installed}
                disabled={
                  !client.found ||
                  blocksManagedToggle(client) ||
                  pendingClients.has(client.id) ||
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
            disabled={doctorPending}
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
