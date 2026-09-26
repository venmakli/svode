import { useState } from "react";
import { Copy, LoaderCircle, Stethoscope } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import type {
  McpArtifactStatus,
  McpClientStatus,
  McpDoctorReport,
  McpStatus,
} from "../hooks/use-mcp-integrations";
import type { AvailableAgent } from "../model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CliAgentStatusBadge, cliAgentNextStep } from "./cli-agent-status";
import {
  SettingsDisclosureTrigger,
  SettingsItem,
  SettingsRows,
} from "./settings-layout";

function attentionDescription(code: McpClientStatus["attentionCode"]) {
  switch (code) {
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
    default:
      return null;
  }
}

// The state of the connection in one line; the section callout already
// explains an unavailable runtime.
function connectionDescription(
  client: McpClientStatus,
  runtimeUpdatedFrom: string | null,
  runtimeExplained: boolean,
) {
  const attention =
    client.attentionCode === "runtime_unavailable" && runtimeExplained
      ? null
      : attentionDescription(client.attentionCode);
  if (attention) return attention;
  if (!client.found) return m.settings_mcp_client_unavailable();
  if (!client.installed) return m.settings_mcp_client_not_installed();
  const version = client.version ?? "—";
  return runtimeUpdatedFrom && runtimeUpdatedFrom !== client.version
    ? m.settings_providers_updated({ version })
    : m.settings_providers_connected({ version });
}

// A conflict refuses connecting; a connected client can always disconnect,
// which removes only what Svode added.
function toggleBlocked(client: McpClientStatus, server: McpStatus["server"]) {
  if (client.attentionCode === "config_unreadable") return true;
  if (client.installed) return false;
  return (
    !client.found ||
    server.status !== "installed" ||
    client.attentionCode === "custom_conflict" ||
    client.attentionCode === "higher_precedence_conflict" ||
    client.attentionCode === "skill_conflict"
  );
}

function artifactState(artifact: McpArtifactStatus | undefined) {
  switch (artifact?.state) {
    case "managed":
      return m.settings_providers_artifact_managed();
    case "previous":
      return m.settings_providers_artifact_previous();
    case "foreign":
      return m.settings_providers_artifact_foreign();
    case "custom":
      return m.settings_providers_artifact_custom();
    case "unreadable":
      return m.settings_providers_artifact_unreadable();
    default:
      return m.settings_providers_artifact_absent();
  }
}

function runtimeVersion(server: McpStatus["server"]) {
  if (!server.runtime) return "—";
  return server.runtime.kind === "desktop"
    ? m.settings_providers_runtime_desktop({ version: server.runtime.version })
    : m.settings_providers_runtime_standalone({
        version: server.runtime.version,
      });
}

function Path({ value }: { value?: string | null }) {
  return (
    <span className="block font-mono text-xs break-all">{value || "—"}</span>
  );
}

function Value({ children }: { children: string }) {
  return (
    <span className="text-sm text-muted-foreground wrap-break-word">
      {children}
    </span>
  );
}

export function ProviderRow({
  client,
  agent,
  server,
  runtimeUpdatedFrom,
  runtimeExplained,
  pending,
  manualConfig,
  doctor,
  doctorPending,
  onToggle,
  onShowManualConfig,
  onCopyManualConfig,
  onRunDoctor,
}: {
  client: McpClientStatus;
  agent: AvailableAgent | undefined;
  server: McpStatus["server"];
  runtimeUpdatedFrom: string | null;
  runtimeExplained: boolean;
  pending: boolean;
  manualConfig: string | undefined;
  doctor: McpDoctorReport | null;
  doctorPending: boolean;
  onToggle: (checked: boolean) => void;
  onShowManualConfig: () => void;
  onCopyManualConfig: () => void;
  onRunDoctor: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const nextStep = agent ? cliAgentNextStep(agent) : null;
  const artifact = (kind: McpArtifactStatus["kind"]) =>
    client.artifacts?.find((candidate) => candidate.kind === kind);
  const skill = artifact("skill");
  const entry = artifact("mcp-entry");
  const reportLines = doctor ? [...doctor.messages, ...doctor.errors] : [];

  return (
    <Collapsible
      open={detailsOpen}
      onOpenChange={setDetailsOpen}
      data-mcp-client={client.id}
      className="min-w-0"
    >
      <SettingsItem
        title={client.name}
        description={
          <>
            <span className="block">
              {connectionDescription(
                client,
                runtimeUpdatedFrom,
                runtimeExplained,
              )}
            </span>
            {nextStep ? <span className="block">{nextStep}</span> : null}
          </>
        }
        actions={
          <>
            {client.status === "attention" ? (
              <Badge variant="destructive">
                {m.settings_mcp_client_attention()}
              </Badge>
            ) : null}
            <SettingsDisclosureTrigger
              open={detailsOpen}
              label={
                detailsOpen
                  ? m.settings_providers_details_hide()
                  : m.settings_providers_details_show()
              }
            />
            {pending ? (
              <LoaderCircle
                aria-hidden
                className="size-4 animate-spin text-muted-foreground"
              />
            ) : null}
            <Switch
              checked={client.installed}
              disabled={toggleBlocked(client, server)}
              aria-disabled={pending || undefined}
              aria-label={m.settings_providers_access_toggle({
                client: client.name,
              })}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onCheckedChange={(checked) => {
                if (!pending) onToggle(checked);
              }}
            />
          </>
        }
      />
      <CollapsibleContent className="min-w-0 border-t bg-muted/40">
        <SettingsRows>
          <SettingsItem
            key="cli"
            title={m.settings_providers_cli()}
            description={<Path value={agent?.path} />}
            actions={
              agent ? (
                <CliAgentStatusBadge agent={agent} />
              ) : (
                <Value>{m.common_loading()}</Value>
              )
            }
          />
          <SettingsItem
            key="svode"
            title="Svode"
            description={<Path value={server.command} />}
            actions={
              <Value>
                {m.settings_providers_versions({
                  integration: client.version ?? "—",
                  runtime: runtimeVersion(server),
                })}
              </Value>
            }
          />
          <SettingsItem
            key="skill"
            title={m.settings_providers_skill()}
            description={<Path value={skill?.path} />}
            actions={<Value>{artifactState(skill)}</Value>}
          />
          <SettingsItem
            key="entry"
            title={m.settings_providers_mcp_entry()}
            description={<Path value={entry?.path ?? client.configPath} />}
            actions={<Value>{artifactState(entry)}</Value>}
          />
          <Collapsible
            key="manual"
            open={configOpen}
            onOpenChange={(open) => {
              setConfigOpen(open);
              if (open) onShowManualConfig();
            }}
          >
            <SettingsItem
              title={m.settings_mcp_manual_config()}
              description={m.settings_mcp_manual_config_description()}
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
                    onClick={onCopyManualConfig}
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
                  value={manualConfig ?? ""}
                  aria-label={m.settings_mcp_manual_config_json({
                    client: client.name,
                  })}
                  className="min-h-24 w-full min-w-0 max-w-full resize-none overflow-x-auto bg-background font-mono text-xs"
                />
              </CollapsibleContent>
            </SettingsItem>
          </Collapsible>
          <Collapsible
            key="doctor"
            open={reportOpen}
            onOpenChange={setReportOpen}
          >
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
                  {reportLines.length > 0 ? (
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
                    onClick={onRunDoctor}
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
                <div className="flex min-w-0 flex-col gap-1 rounded-md bg-background p-3 font-mono text-xs text-muted-foreground">
                  {reportLines.map((line) => (
                    <p
                      key={line}
                      className="break-all [overflow-wrap:anywhere]"
                    >
                      {line}
                    </p>
                  ))}
                </div>
              </CollapsibleContent>
            </SettingsItem>
          </Collapsible>
        </SettingsRows>
      </CollapsibleContent>
    </Collapsible>
  );
}
