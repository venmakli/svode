import { TriangleAlert } from "lucide-react";

import * as m from "@/paraglide/messages.js";

/** A short note above a body that the scanner truncated. */
export function AgentContextContentTruncatedNotice({
  truncated,
}: {
  truncated: boolean;
}) {
  if (!truncated) return null;
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
