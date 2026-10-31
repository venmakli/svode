import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ResolveWithAgent } from "../hooks/use-resolve-with-agent";
import * as m from "@/paraglide/messages.js";

/**
 * «Разрешить с агентом» of the Git sync Dialog footer (Stage 11 1.F), or
 * the `label` of the stop it serves («Разобраться с агентом» at an
 * operation). Where no chat session can open, it is unavailable and says why.
 */
export function GitResolveWithAgentButton({
  agent,
  disabled,
  label = m.git_resolve_with_agent(),
}: {
  agent: ResolveWithAgent;
  disabled: boolean;
  label?: string;
}) {
  const reason =
    agent.available === false ? m.git_resolve_with_agent_unavailable() : null;
  const button = (
    <Button
      type="button"
      variant="outline"
      className="w-full sm:w-auto"
      disabled={disabled || agent.available !== true || agent.preparing}
      aria-busy={agent.preparing}
      onClick={() => void agent.resolve()}
      data-git-resolve-with-agent
    >
      {agent.preparing && (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      )}
      {label}
    </Button>
  );
  if (!reason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex w-full sm:w-auto"
          aria-label={`${label}. ${reason}`}
          data-git-resolve-with-agent-reason
        >
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
