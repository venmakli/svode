import { useState } from "react";
import { ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import * as m from "@/paraglide/messages.js";

import type { AgentContextSkillRow } from "../model/types";

export function AgentContextSkillFrontmatterDisclosure({
  row,
}: {
  row: AgentContextSkillRow;
}) {
  const fields = skillFrontmatterFields(row);
  const [disclosure, setDisclosure] = useState({
    artifactId: row.id,
    open: false,
  });
  const open = disclosure.artifactId === row.id && disclosure.open;

  if (!fields.hasValues) return null;

  return (
    <Collapsible
      className="rounded-lg border"
      data-agent-context-skill-frontmatter={row.id}
      open={open}
      onOpenChange={(nextOpen) => {
        setDisclosure({ artifactId: row.id, open: nextOpen });
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
        <span className="text-sm font-medium">
          {m.agent_context_skill_parameters()}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex min-w-0 flex-col gap-4 border-t px-3 py-3">
          {fields.hasStandardValues ? (
            <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              {row.license !== null ? (
                <FrontmatterField
                  label={m.agent_context_skill_parameter_license()}
                  value={row.license}
                />
              ) : null}
              {row.compatibility !== null ? (
                <FrontmatterField
                  label={m.agent_context_skill_parameter_compatibility()}
                  value={row.compatibility}
                />
              ) : null}
              {row.allowedTools !== null ? (
                <>
                  <dt className="text-muted-foreground">
                    {m.agent_context_skill_parameter_allowed_tools()}
                  </dt>
                  <dd className="min-w-0">
                    <code className="block min-w-0 whitespace-pre-wrap break-words font-mono select-text [overflow-wrap:anywhere]">
                      {row.allowedTools}
                    </code>
                    <span className="mt-1 block text-muted-foreground">
                      {m.agent_context_skill_parameter_allowed_tools_hint()}
                    </span>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {fields.metadata.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xs font-medium">
                {m.agent_context_skill_parameter_metadata()}
              </h3>
              <dl className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                {fields.metadata.map(([key, value]) => (
                  <FrontmatterField key={key} label={key} value={value} />
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function skillFrontmatterFields(row: AgentContextSkillRow): {
  hasStandardValues: boolean;
  hasValues: boolean;
  metadata: readonly (readonly [string, string])[];
} {
  const metadata = Object.entries(row.metadata ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const hasStandardValues =
    row.license !== null ||
    row.compatibility !== null ||
    row.allowedTools !== null;
  return {
    hasStandardValues,
    hasValues: hasStandardValues || metadata.length > 0,
    metadata,
  };
}

function FrontmatterField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]">
        {label}
      </dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words select-text [overflow-wrap:anywhere]">
        {value}
      </dd>
    </>
  );
}
