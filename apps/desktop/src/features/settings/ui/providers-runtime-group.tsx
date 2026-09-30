import { useState } from "react";
import { LoaderCircle, Stethoscope } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import type { McpDoctorReport, McpStatus } from "../hooks/use-mcp-integrations";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
} from "./settings-layout";

function runtimeState(server: McpStatus["server"]) {
  if (server.status === "not_found") {
    return m.settings_providers_runtime_unavailable();
  }
  if (!server.runtime) return "—";
  return server.runtime.kind === "desktop"
    ? m.settings_providers_runtime_desktop({ version: server.runtime.version })
    : m.settings_providers_runtime_standalone({
        version: server.runtime.version,
      });
}

// The runtime and its check describe this device, not one agent, so they are
// shown once for the whole section.
export function ProvidersRuntimeGroup({
  server,
  doctor,
  doctorPending,
  onRunDoctor,
}: {
  server: McpStatus["server"] | undefined;
  doctor: McpDoctorReport | null;
  doctorPending: boolean;
  onRunDoctor: () => void;
}) {
  const [reportOpen, setReportOpen] = useState(false);
  const reportLines = doctor ? [...doctor.messages, ...doctor.errors] : [];

  return (
    <SettingsGroup
      title={m.settings_providers_runtime_group()}
      aria-busy={!server}
      data-mcp-runtime
    >
      {server ? (
        <SettingsItem
          key="runtime"
          title={m.settings_providers_runtime_active()}
          description={
            <span className="block font-mono text-xs break-all">
              {server.command || "—"}
            </span>
          }
          actions={
            <span className="text-sm text-muted-foreground wrap-break-word">
              {runtimeState(server)}
            </span>
          }
        />
      ) : (
        <SettingsRowSkeleton key="runtime" />
      )}
      <Collapsible key="doctor" open={reportOpen} onOpenChange={setReportOpen}>
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
            <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {reportLines.map((line) => (
                <p key={line} className="break-all [overflow-wrap:anywhere]">
                  {line}
                </p>
              ))}
            </div>
          </CollapsibleContent>
        </SettingsItem>
      </Collapsible>
    </SettingsGroup>
  );
}
