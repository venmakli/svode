import { useState } from "react";
import {
  Copy,
  LoaderCircle,
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
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
} from "./settings-layout";

function serverBadge(status: McpStatus["server"]["status"]) {
  if (status === "installed") {
    return (
      <Badge variant="secondary">{m.settings_mcp_server_installed()}</Badge>
    );
  }
  return <Badge variant="outline">{m.settings_mcp_server_not_found()}</Badge>;
}

function clientDescription(client: McpClientStatus) {
  switch (client.attentionCode) {
    case "client_policy_blocked":
      return m.settings_mcp_client_policy_blocked();
    case "config_unreadable":
      return m.settings_mcp_client_config_unreadable();
    case "custom_conflict":
      return m.settings_mcp_client_custom_conflict();
    case "higher_precedence_conflict":
      return m.settings_mcp_client_higher_precedence_conflict();
    case "incomplete":
      return m.settings_mcp_client_incomplete();
    case "mcp_start_failed":
      return m.settings_mcp_client_mcp_start_failed();
    case "repair_failed":
      return m.settings_mcp_client_repair_failed();
    case "runtime_unavailable":
      return m.settings_mcp_client_runtime_unavailable();
    case "skill_conflict":
      return m.settings_mcp_client_skill_conflict();
  }
  if (client.status === "not_found") return m.settings_mcp_client_unavailable();
  return client.installed
    ? m.settings_mcp_client_installed()
    : m.settings_mcp_client_not_installed();
}

// A conflict refuses connecting; a connected client can always disconnect,
// which removes only what Svode added.
function blocksManagedToggle(client: McpClientStatus) {
  if (client.attentionCode === "config_unreadable") return true;
  return (
    !client.installed &&
    (client.attentionCode === "custom_conflict" ||
      client.attentionCode === "higher_precedence_conflict" ||
      client.attentionCode === "skill_conflict")
  );
}

function reportLines(report: McpDoctorReport | null) {
  if (!report) return [];
  return [...report.messages, ...report.errors];
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
  const [configOpen, setConfigOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const lines = reportLines(doctor);

  return (
    <>
      <Alert className="min-w-0 max-w-full">
        <TriangleAlert data-icon="inline-start" />
        <AlertTitle className="min-w-0">
          {m.settings_mcp_pii_warning_title()}
        </AlertTitle>
        <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
          {m.settings_mcp_pii_warning_description()}
        </AlertDescription>
      </Alert>

      <SettingsGroup title={m.settings_mcp_server_section()}>
        <SettingsItem
          title="svode-mcp"
          description={
            status ? (
              <span className="block truncate" title={serverPath(status)}>
                {serverPath(status)}
              </span>
            ) : (
              m.common_loading()
            )
          }
          actions={
            <>
              {status ? serverBadge(status.server.status) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={loadStatus}
                disabled={refreshing}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={refreshing ? "animate-spin" : undefined}
                />
                {m.settings_mcp_refresh()}
              </Button>
            </>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title={m.settings_mcp_clients_section()}
        description={m.settings_mcp_explicit_action_hint()}
        aria-busy={!status}
      >
        {status
          ? status.clients.map((client) => (
              <SettingsItem
                key={client.id}
                data-mcp-client={client.id}
                title={client.name}
                description={clientDescription(client)}
                actions={
                  <>
                    {client.status === "attention" ? (
                      <Badge variant="destructive">
                        {m.settings_mcp_client_attention()}
                      </Badge>
                    ) : null}
                    {pendingClients.has(client.id) ? (
                      <LoaderCircle
                        aria-hidden
                        className="size-4 animate-spin text-muted-foreground"
                      />
                    ) : null}
                    <Switch
                      checked={client.installed}
                      disabled={
                        !client.found ||
                        blocksManagedToggle(client) ||
                        status.server.status !== "installed"
                      }
                      aria-disabled={pendingClients.has(client.id) || undefined}
                      aria-label={m.settings_mcp_client_toggle({
                        client: client.name,
                      })}
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      onCheckedChange={(checked) => {
                        if (!pendingClients.has(client.id))
                          void handleToggle(client, checked);
                      }}
                    />
                  </>
                }
              />
            ))
          : [
              <SettingsRowSkeleton key="first" />,
              <SettingsRowSkeleton key="second" />,
            ]}
      </SettingsGroup>

      <SettingsGroup
        title={m.settings_mcp_manual_config()}
        description={m.settings_mcp_manual_config_description()}
      >
        <Collapsible open={configOpen} onOpenChange={setConfigOpen}>
          <SettingsItem
            title={m.settings_mcp_manual_config_json()}
            actions={
              <>
                <SettingsDisclosureTrigger
                  open={configOpen}
                  label={
                    configOpen
                      ? m.settings_mcp_manual_config_hide()
                      : m.settings_mcp_manual_config_show()
                  }
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyConfig}
                  disabled={!manualConfigText}
                >
                  <Copy data-icon="inline-start" />
                  {m.settings_mcp_copy_manual_config()}
                </Button>
              </>
            }
          >
            <CollapsibleContent className="basis-full">
              <Textarea
                readOnly
                value={manualConfigText}
                aria-label={m.settings_mcp_manual_config_json()}
                className="min-h-32 w-full min-w-0 max-w-full resize-none overflow-x-auto font-mono text-xs"
              />
            </CollapsibleContent>
          </SettingsItem>
        </Collapsible>
      </SettingsGroup>

      <SettingsGroup title={m.settings_mcp_doctor_section()}>
        <Collapsible open={reportOpen} onOpenChange={setReportOpen}>
          <SettingsItem
            title={m.settings_mcp_doctor_check()}
            description={
              doctor
                ? doctor.ok
                  ? m.settings_mcp_doctor_ok()
                  : m.settings_mcp_doctor_failed()
                : m.common_loading()
            }
            actions={
              <>
                {lines.length > 0 ? (
                  <SettingsDisclosureTrigger
                    open={reportOpen}
                    label={
                      reportOpen
                        ? m.settings_mcp_doctor_report_hide()
                        : m.settings_mcp_doctor_report_show()
                    }
                  />
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDoctor}
                  disabled={doctorPending}
                >
                  {doctorPending ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Stethoscope data-icon="inline-start" />
                  )}
                  {m.settings_mcp_run_doctor()}
                </Button>
              </>
            }
          >
            <CollapsibleContent className="basis-full">
              <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
                {lines.map((line) => (
                  <p key={line} className="break-all [overflow-wrap:anywhere]">
                    {line}
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </SettingsItem>
        </Collapsible>
      </SettingsGroup>
    </>
  );
}

function serverPath(status: McpStatus) {
  return status.server.command ?? status.server.message ?? "";
}
