import { CollectionPropertyPanel } from "@/features/properties/panel";
import type { CollectionPropertyDefinition } from "@/features/properties";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import type { AgentContextInstructionRow } from "../model/types";
import { AgentContextContentTruncatedNotice } from "./content-truncated-notice";

const instructionReaderPolicy: MarkdownReaderPolicy = {};

/** An instruction has no header: its panel follows the peek top bar. */
export function AgentContextInstructionDetail({
  properties,
  row,
}: {
  properties: readonly CollectionPropertyDefinition<AgentContextInstructionRow>[];
  row: AgentContextInstructionRow;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-instruction-detail={row.id}
    >
      <CollectionPropertyPanel properties={properties} row={row} />
      <AgentContextContentTruncatedNotice truncated={row.truncated} />
      <MarkdownReader content={row.body} policy={instructionReaderPolicy} />
    </div>
  );
}
