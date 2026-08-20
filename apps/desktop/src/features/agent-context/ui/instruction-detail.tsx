import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import * as m from "@/paraglide/messages.js";
import { MarkdownReader, type MarkdownReaderPolicy } from "@/shared/ui/markdown-reader";

import type {
  AgentContextInstructionRow,
  AgentContextReference,
} from "../model/types";
import {
  instructionAdapterLabel,
  instructionRoleLabel,
  instructionScopeLabel,
  sourceResolutionLabel,
  sourceSupportLabel,
} from "./instruction-labels";

const instructionReaderPolicy: MarkdownReaderPolicy = {
  openLink: () => undefined,
  resolveImageSource: () => null,
  resolveLink: () => null,
};

export function AgentContextInstructionDetail({
  row,
}: {
  row: AgentContextInstructionRow;
}) {
  const healthReasons =
    row.health === "degraded"
      ? row.healthReasons.length > 0
        ? row.healthReasons
        : [m.agent_context_health_degraded()]
      : [];

  return (
    <div
      className="flex min-w-0 flex-col gap-5"
      data-agent-context-instruction-detail={row.id}
    >
      <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <DetailTerm>{m.agent_context_adapter()}</DetailTerm>
        <DetailValue>{instructionAdapterLabel(row.adapterId)}</DetailValue>
        <DetailTerm>{m.agent_context_detail_role()}</DetailTerm>
        <DetailValue>{instructionRoleLabel(row.role)}</DetailValue>
        <DetailTerm>{m.agent_context_scope()}</DetailTerm>
        <DetailValue>
          <Badge variant="outline">{instructionScopeLabel(row.scope)}</Badge>
        </DetailValue>
        <DetailTerm>{m.agent_context_source_support()}</DetailTerm>
        <DetailValue>
          <Badge variant="outline">{sourceSupportLabel(row.support)}</Badge>
        </DetailValue>
        <DetailTerm>{m.agent_context_resolution()}</DetailTerm>
        <DetailValue>
          <Badge variant="outline">
            {sourceResolutionLabel(row.resolution)}
          </Badge>
        </DetailValue>
        <DetailTerm>{m.agent_context_detail_owner()}</DetailTerm>
        <DetailPath>{row.ownerPath}</DetailPath>
        <DetailTerm>{m.agent_context_detail_canonical_path()}</DetailTerm>
        <DetailPath>{row.canonicalPath}</DetailPath>
        <DetailTerm>{m.agent_context_detail_discovery_path()}</DetailTerm>
        <DetailPath>{row.discoveryPath}</DetailPath>
        {row.linkTargetPath ? (
          <>
            <DetailTerm>{m.agent_context_detail_link_target()}</DetailTerm>
            <DetailPath>{row.linkTargetPath}</DetailPath>
          </>
        ) : null}
        {row.precedence !== null ? (
          <>
            <DetailTerm>{m.agent_context_detail_precedence()}</DetailTerm>
            <DetailValue>{row.precedence}</DetailValue>
          </>
        ) : null}
      </dl>

      {row.references.length > 0 ? (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">
            {m.agent_context_detail_references()}
          </h3>
          <ul className="flex min-w-0 flex-col gap-2 text-xs">
            {row.references.map((reference, index) => (
              <li
                key={`${reference.path}:${index}`}
                className="flex min-w-0 flex-col gap-0.5 rounded-md border p-2"
              >
                <code className="break-all">{reference.path}</code>
                <span className="text-muted-foreground">
                  {referenceStatusLabel(reference.status)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {healthReasons.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription className="flex flex-col gap-1">
            {healthReasons.map((reason, index) => (
              <span key={`${reason}:${index}`}>{reason}</span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <MarkdownReader content={row.body} policy={instructionReaderPolicy} />
    </div>
  );
}

function DetailTerm({ children }: React.PropsWithChildren) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function DetailValue({
  children,
  className,
}: React.PropsWithChildren<{ className?: string }>) {
  return <dd className={className}>{children}</dd>;
}

function DetailPath({ children }: React.PropsWithChildren) {
  return <dd className="min-w-0 break-all font-mono text-xs">{children}</dd>;
}

function referenceStatusLabel(status: AgentContextReference["status"]) {
  if (status === "available") {
    return m.agent_context_detail_reference_status_available();
  }
  if (status === "outside_boundary") {
    return m.agent_context_detail_reference_status_outside_boundary();
  }
  if (status === "requires_client_approval") {
    return m.agent_context_detail_reference_status_requires_client_approval();
  }
  return m.agent_context_detail_reference_status_unreadable();
}
