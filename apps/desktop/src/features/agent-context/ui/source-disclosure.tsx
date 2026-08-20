import { useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import * as m from "@/paraglide/messages.js";

import type {
  AgentContextDetailProvenance,
  AgentContextDetailSource,
} from "../model/detail-provenance";
import type { AgentContextReference } from "../model/types";
import {
  instructionRoleLabel,
  sourceFamilyLabel,
  sourceLinkKindLabel,
  sourceLocationLabel,
  sourceResolutionLabel,
  sourceSupportLabel,
} from "./provenance-labels";

export function AgentContextSourceDisclosure({
  provenance,
}: {
  provenance: AgentContextDetailProvenance;
}) {
  const [disclosure, setDisclosure] = useState({
    artifactId: provenance.artifactId,
    open: false,
  });
  const open =
    disclosure.artifactId === provenance.artifactId && disclosure.open;

  return (
    <Collapsible
      className="rounded-lg border"
      data-agent-context-source-disclosure={provenance.artifactId}
      open={open}
      onOpenChange={(nextOpen) => {
        setDisclosure({
          artifactId: provenance.artifactId,
          open: nextOpen,
        });
      }}
    >
      <CollapsibleTrigger
        className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
      >
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {m.agent_context_detail_source_and_location()}
          </span>
          <span
            className="block truncate text-xs text-muted-foreground"
            data-agent-context-source-summary
          >
            {sourceSummary(provenance)}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex min-w-0 flex-col gap-4 border-t px-3 py-3">
          {provenance.isSingleDirectSource ? (
            <SingleDirectSource provenance={provenance} />
          ) : (
            <>
              <CanonicalSource provenance={provenance} />
              <DiscoverySources sources={provenance.sources} />
            </>
          )}
          {provenance.references.length > 0 ? (
            <InstructionReferences references={provenance.references} />
          ) : null}
          {provenance.diagnostics.length > 0 ? (
            <DetailDiagnostics diagnostics={provenance.diagnostics} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentContextContentHealthNotice({
  provenance,
}: {
  provenance: AgentContextDetailProvenance;
}) {
  if (!provenance.contentTruncated) return null;
  return (
    <p
      className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"
      data-agent-context-content-health
      role="note"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{m.agent_context_detail_truncated()}</span>
    </p>
  );
}

function SingleDirectSource({
  provenance,
}: {
  provenance: AgentContextDetailProvenance;
}) {
  const source = provenance.sources[0];
  if (!source) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">
        {m.agent_context_detail_source_file()}
      </h3>
      <PathText>{provenance.canonicalSourcePath}</PathText>
      <SourceFacts source={source} />
    </section>
  );
}

function CanonicalSource({
  provenance,
}: {
  provenance: AgentContextDetailProvenance;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-agent-context-canonical-source
    >
      <h3 className="text-sm font-medium">
        {m.agent_context_detail_canonical_source()}
      </h3>
      <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <DetailTerm>{m.agent_context_detail_canonical_owner()}</DetailTerm>
        <DetailPath>{provenance.canonicalOwnerPath}</DetailPath>
        <DetailTerm>{m.agent_context_detail_source_file()}</DetailTerm>
        <DetailPath>{provenance.canonicalSourcePath}</DetailPath>
      </dl>
    </section>
  );
}

function DiscoverySources({
  sources,
}: {
  sources: readonly AgentContextDetailSource[];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">
        {m.agent_context_detail_discovery_sources()}
      </h3>
      <ul className="flex min-w-0 flex-col gap-2">
        {sources.map((source) => (
          <li
            className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
            key={sourceIdentity(source)}
          >
            <SourceFacts source={source} />
            <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <DetailTerm>{m.agent_context_detail_discovery_path()}</DetailTerm>
              <DetailPath>{source.path}</DetailPath>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceFacts({ source }: { source: AgentContextDetailSource }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {source.sourceFamily ? (
          <Badge variant="outline">
            {sourceFamilyLabel(source.sourceFamily)}
          </Badge>
        ) : null}
        <Badge variant="outline">{sourceLocationLabel(source.location)}</Badge>
        <Badge variant="outline">{sourceLinkKindLabel(source.linkKind)}</Badge>
        <Badge variant="outline">{sourceSupportLabel(source.support)}</Badge>
        <Badge variant="outline">
          {sourceResolutionLabel(source.resolution)}
        </Badge>
      </div>
      {source.role || source.precedence !== null ? (
        <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {source.role ? (
            <>
              <DetailTerm>{m.agent_context_detail_role()}</DetailTerm>
              <DetailValue>{instructionRoleLabel(source.role)}</DetailValue>
            </>
          ) : null}
          {source.precedence !== null ? (
            <>
              <DetailTerm>{m.agent_context_detail_precedence()}</DetailTerm>
              <DetailValue>{source.precedence}</DetailValue>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function InstructionReferences({
  references,
}: {
  references: readonly AgentContextReference[];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">
        {m.agent_context_detail_references()}
      </h3>
      <ul className="flex min-w-0 flex-col gap-2 text-xs">
        {references.map((reference) => (
          <li
            className="flex min-w-0 flex-col gap-0.5 rounded-md border p-2"
            key={`${reference.status}:${reference.path}`}
          >
            <PathText>{reference.path}</PathText>
            <span className="text-muted-foreground">
              {referenceStatusLabel(reference.status)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DetailDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly string[];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">
        {m.agent_context_detail_diagnostics()}
      </h3>
      <ul className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        {diagnostics.map((diagnostic) => (
          <li className="break-words" key={diagnostic}>
            {diagnostic}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DetailTerm({ children }: React.PropsWithChildren) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function DetailValue({ children }: React.PropsWithChildren) {
  return <dd>{children}</dd>;
}

function DetailPath({ children }: React.PropsWithChildren) {
  return (
    <dd className="min-w-0">
      <PathText>{children}</PathText>
    </dd>
  );
}

function PathText({ children }: React.PropsWithChildren) {
  return (
    <code className="block min-w-0 whitespace-normal break-all font-mono text-xs select-text">
      {children}
    </code>
  );
}

function sourceSummary(provenance: AgentContextDetailProvenance): string {
  const labels = [
    ...provenance.sourceFamilies.map(sourceFamilyLabel),
    ...provenance.sourceLocations.map(sourceLocationLabel),
  ];
  if (provenance.kind === "skill") {
    labels.push(
      m.agent_context_detail_source_count({
        count: String(provenance.sources.length),
      }),
    );
  }
  const linkKinds = new Set(
    provenance.sources
      .filter((source) => source.linkKind !== "direct")
      .map((source) => source.linkKind),
  );
  labels.push(...[...linkKinds].map(sourceLinkKindLabel));
  return labels.join(" · ");
}

function sourceIdentity(source: AgentContextDetailSource): string {
  return [
    source.sourceFamily,
    source.location,
    source.linkKind,
    source.support,
    source.resolution,
    source.path,
  ].join(":");
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
