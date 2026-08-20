import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import { instructionDetailProvenance } from "../model/detail-provenance";
import type { AgentContextInstructionRow } from "../model/types";
import {
  AgentContextContentHealthNotice,
  AgentContextSourceDisclosure,
} from "./source-disclosure";

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
  const provenance = instructionDetailProvenance(row);

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-instruction-detail={row.id}
    >
      <AgentContextSourceDisclosure provenance={provenance} />
      <AgentContextContentHealthNotice provenance={provenance} />
      <MarkdownReader content={row.body} policy={instructionReaderPolicy} />
    </div>
  );
}
