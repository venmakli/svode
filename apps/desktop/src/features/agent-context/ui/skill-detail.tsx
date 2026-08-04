import { AlertTriangle, Link2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import * as m from "@/paraglide/messages.js";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import type { AgentContextSkillRow } from "../model/types";
import {
  availabilityLabel,
  availabilityVariant,
  instructionAdapterLabel,
  instructionScopeLabel,
} from "./instruction-labels";

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

      <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <DetailTerm>{m.agent_context_detail_owner()}</DetailTerm>
        <DetailPath>{row.ownerPath}</DetailPath>
        <DetailTerm>{m.agent_context_detail_canonical_path()}</DetailTerm>
        <DetailPath>{row.manifestPath}</DetailPath>
      </dl>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium">
          {m.agent_context_skill_provenance()}
        </h3>
        <ul className="flex min-w-0 flex-col gap-2">
          {row.aliases.map((alias) => (
            <li
              key={`${alias.adapterId}:${alias.scope}:${alias.discoveryKind}:${alias.discoveryPath}`}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">
                  {instructionAdapterLabel(alias.adapterId)}
                </Badge>
                <Badge variant="outline">
                  {instructionScopeLabel(alias.scope)}
                </Badge>
                <Badge variant={availabilityVariant(alias.availability)}>
                  {availabilityLabel(alias.availability)}
                </Badge>
                {alias.linkKind !== "direct" ? (
                  <Badge variant="outline">
                    <Link2 aria-hidden />
                    {m.agent_context_skill_alias()}
                  </Badge>
                ) : null}
              </div>
              {alias.availabilityReason ? (
                <p className="text-xs text-muted-foreground">
                  {alias.availabilityReason}
                </p>
              ) : null}
              <dl className="grid min-w-0 grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <DetailTerm>{m.agent_context_detail_owner()}</DetailTerm>
                <DetailPath>{alias.ownerPath}</DetailPath>
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
  return Array.from(
    new Set([
      ...row.warnings,
      ...row.diagnostics,
      ...row.aliases.flatMap((alias) =>
        alias.availability !== "available" && alias.availabilityReason
          ? [alias.availabilityReason]
          : [],
      ),
    ]),
  );
}

function DetailTerm({ children }: React.PropsWithChildren) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function DetailPath({ children }: React.PropsWithChildren) {
  return <dd className="min-w-0 break-all font-mono text-xs">{children}</dd>;
}
