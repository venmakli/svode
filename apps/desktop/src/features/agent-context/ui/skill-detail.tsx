import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import * as m from "@/paraglide/messages.js";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import type { AgentContextSkillRow } from "../model/types";
import {
  sourceFamilyLabel,
  sourceLinkKindLabel,
  sourceLocationLabel,
  sourceResolutionLabel,
} from "./provenance-labels";

const skillReaderPolicy: MarkdownReaderPolicy = {
  openLink: () => undefined,
  resolveImageSource: () => null,
  resolveLink: () => null,
};

export function AgentContextSkillDetail({
  row,
}: {
  row: AgentContextSkillRow;
}) {
  const warnings = skillWarnings(row);
  return (
    <div
      className="flex min-w-0 flex-col gap-5"
      data-agent-context-skill-detail={row.id}
    >
      <p className="rounded-lg border bg-muted/35 px-4 py-3 text-sm leading-relaxed">
        {row.description}
      </p>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium">
          {m.agent_context_detail_canonical_source()}
        </h3>
        <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <DetailTerm>{m.agent_context_detail_canonical_owner()}</DetailTerm>
          <DetailPath>{row.ownerPath}</DetailPath>
          <DetailTerm>{m.agent_context_detail_canonical_path()}</DetailTerm>
          <DetailPath>{row.manifestPath}</DetailPath>
        </dl>
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium">
          {m.agent_context_detail_discovery_sources()}
        </h3>
        <ul className="flex min-w-0 flex-col gap-2">
          {row.aliases.map((alias) => (
            <li
              key={`${alias.sourceFamily}:${alias.location}:${alias.linkKind}:${alias.discoveryPath}`}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">
                  {sourceFamilyLabel(alias.sourceFamily)}
                </Badge>
                <Badge variant="outline">
                  {sourceLocationLabel(alias.location)}
                </Badge>
                <Badge variant="outline">
                  {sourceLinkKindLabel(alias.linkKind)}
                </Badge>
                <Badge variant="outline">
                  {sourceResolutionLabel(alias.resolution)}
                </Badge>
              </div>
              <dl className="grid min-w-0 grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <DetailTerm>
                  {m.agent_context_detail_discovery_path()}
                </DetailTerm>
                <DetailPath>{alias.discoveryPath}</DetailPath>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      {warnings.length > 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription className="flex flex-col gap-1">
            {warnings.map((warning, index) => (
              <span key={`${warning}:${index}`}>{warning}</span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <MarkdownReader content={row.body} policy={skillReaderPolicy} />
    </div>
  );
}

export function skillWarnings(row: AgentContextSkillRow): readonly string[] {
  if (row.health !== "degraded") return [];
  return row.healthReasons.length > 0
    ? Array.from(new Set(row.healthReasons))
    : [m.agent_context_health_degraded()];
}

function DetailTerm({ children }: React.PropsWithChildren) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function DetailPath({ children }: React.PropsWithChildren) {
  return <dd className="min-w-0 break-all font-mono text-xs">{children}</dd>;
}
