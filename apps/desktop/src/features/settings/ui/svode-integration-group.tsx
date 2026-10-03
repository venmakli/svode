import { useState } from "react";
import { Copy, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import type { McpClientAttentionCode } from "../api";
import type { McpStatus } from "../hooks/use-mcp-integrations";
import {
  integrationParts,
  manualConfigJson,
  type IntegrationActivity,
  type IntegrationOperation,
  type IntegrationPartRow,
} from "../model/svode-integration";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
} from "./settings-layout";

export function problemText(
  code: McpClientAttentionCode,
  configPath: string | null,
) {
  switch (code) {
    case "incomplete":
      return m.settings_integration_problem_incomplete();
    case "repair_failed":
      return m.settings_integration_problem_repair_failed();
    case "custom_conflict":
      return m.settings_integration_problem_custom_conflict({
        path: configPath ?? "",
      });
    case "higher_precedence_conflict":
      return m.settings_integration_problem_higher_precedence_conflict();
    case "skill_conflict":
      return m.settings_integration_problem_skill_conflict();
    case "config_unreadable":
      return m.settings_integration_problem_config_unreadable();
    case "client_policy_blocked":
      return m.settings_integration_problem_client_policy_blocked();
    case "mcp_start_failed":
      return m.settings_integration_problem_mcp_start_failed();
    case "runtime_unavailable":
      return m.settings_mcp_client_runtime_unavailable();
  }
}

export function externalText(source: string | null) {
  return source
    ? m.settings_integration_external_source({ source })
    : m.settings_integration_external();
}

function partTitle(part: "plugin" | "mcp" | "shared") {
  switch (part) {
    case "plugin":
      return m.settings_integration_part_plugin();
    case "mcp":
      return m.settings_integration_part_mcp();
    case "shared":
      return m.settings_integration_part_shared();
  }
}

function rowKey(row: IntegrationPartRow) {
  switch (row.kind) {
    case "installed":
      return `installed:${row.part}`;
    case "shared":
    case "shared_conflict":
      return row.kind;
    default:
      return `${row.kind}:${row.agent ?? "shared"}`;
  }
}

/**
 * What of Svode is installed and for whom: the parts with the agents they
 * serve, their problems, the runtime callouts and the manual config.
 */
export function SvodeIntegrationGroup({
  status,
  doctorBridgeIncompatible,
  activity,
  changed,
  label,
  onManage,
  onRun,
  onCopyManualConfig,
}: {
  status: McpStatus | null;
  doctorBridgeIncompatible: boolean;
  activity: IntegrationActivity;
  changed: boolean;
  label: (agent: string) => string;
  onManage: () => void;
  onRun: (operation: IntegrationOperation) => void;
  onCopyManualConfig: () => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const rows = status ? integrationParts(status, activity) : null;
  const empty = rows?.length === 0;
  const runtimeUnavailable = status?.server.status === "not_found";
  const version = status?.server.version;
  const updatedFrom = status?.runtimeUpdatedFrom;
  const updated = Boolean(version && updatedFrom && updatedFrom !== version);
  const names = (agents: string[]) => agents.map(label).join(", ");

  const describe = (row: IntegrationPartRow) => {
    const agentPrefix = (text: string) =>
      row.kind !== "installed" && "agent" in row && row.agent
        ? `${label(row.agent)} · ${text}`
        : text;
    switch (row.kind) {
      case "installed":
        return names(row.agents);
      case "shared":
        return row.readers.length
          ? m.settings_integration_readers({ agents: names(row.readers) })
          : m.settings_integration_no_readers();
      case "shared_conflict":
        return m.settings_integration_shared_conflict({ path: row.path });
      case "external":
        return agentPrefix(externalText(row.source));
      case "problem":
        return agentPrefix(problemText(row.code, row.configPath));
      case "pending":
        return agentPrefix(
          row.operation === "install"
            ? m.settings_integration_pending_install()
            : m.settings_integration_pending_remove(),
        );
      case "failed":
        return agentPrefix(
          row.operation.kind === "install"
            ? m.settings_integration_failed_install({ reason: row.message })
            : m.settings_integration_failed_remove({ reason: row.message }),
        );
    }
  };

  const actions = (row: IntegrationPartRow) => {
    if (row.kind === "pending")
      return (
        <LoaderCircle
          aria-hidden
          className="size-4 animate-spin text-muted-foreground"
        />
      );
    if (row.kind === "failed")
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRun(row.operation)}
        >
          {m.settings_agents_action_retry()}
        </Button>
      );
    if (row.kind === "problem" && row.fixable)
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRun({ kind: "install", client: row.agent })}
        >
          {m.settings_integration_fix()}
        </Button>
      );
    return null;
  };

  const attention = (row: IntegrationPartRow) =>
    row.kind === "problem" ||
    row.kind === "failed" ||
    row.kind === "shared_conflict";

  return (
    <SettingsGroup
      title={m.settings_integration_title()}
      description={m.settings_integration_description()}
      aria-busy={!status}
      data-svode-integration
      action={
        status && !empty ? (
          <Button variant="outline" size="sm" onClick={onManage}>
            {m.settings_integration_manage()}
          </Button>
        ) : null
      }
      callout={
        <>
          {runtimeUnavailable || doctorBridgeIncompatible ? (
            <Alert variant="destructive" className="min-w-0 max-w-full">
              <TriangleAlert data-icon="inline-start" />
              <AlertTitle className="min-w-0">
                {runtimeUnavailable
                  ? m.settings_providers_runtime_unavailable_title()
                  : m.settings_providers_bridge_incompatible_title()}
              </AlertTitle>
              <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                {runtimeUnavailable
                  ? m.settings_mcp_client_runtime_unavailable()
                  : m.settings_providers_bridge_incompatible_description()}
              </AlertDescription>
            </Alert>
          ) : null}
          {(updated && !empty) || changed ? (
            <Alert className="min-w-0 max-w-full" data-integration-restart>
              <Info data-icon="inline-start" />
              <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                {updated && version
                  ? m.settings_providers_updated({ version })
                  : m.settings_integration_restart()}
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      }
    >
      {rows
        ? [
            ...(empty
              ? [
                  <SettingsItem
                    key="empty"
                    data-integration-empty
                    title={m.settings_integration_empty()}
                    actions={
                      <Button variant="outline" size="sm" onClick={onManage}>
                        {m.settings_integration_install()}
                      </Button>
                    }
                  />,
                ]
              : rows.map((row) => (
                  <SettingsItem
                    key={rowKey(row)}
                    data-integration-part={rowKey(row)}
                    title={partTitle(
                      row.kind === "shared" || row.kind === "shared_conflict"
                        ? "shared"
                        : row.part,
                    )}
                    description={
                      <span
                        className={
                          attention(row) ? "text-destructive" : undefined
                        }
                      >
                        {describe(row)}
                      </span>
                    }
                    actions={actions(row)}
                  />
                ))),
            <Collapsible
              key="manual"
              open={configOpen}
              onOpenChange={setConfigOpen}
              className="min-w-0"
            >
              <SettingsItem
                data-manual-config
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
                    value={status ? manualConfigJson(status.manualConfig) : ""}
                    aria-label={m.settings_mcp_manual_config_json()}
                    className="min-h-32 w-full min-w-0 max-w-full resize-none overflow-x-auto bg-background font-mono text-xs"
                  />
                </CollapsibleContent>
              </SettingsItem>
            </Collapsible>,
          ]
        : [
            <SettingsRowSkeleton key="first" />,
            <SettingsRowSkeleton key="second" />,
          ]}
    </SettingsGroup>
  );
}
