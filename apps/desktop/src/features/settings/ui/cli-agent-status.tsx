import { ArrowUpRight } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AvailableAgent } from "../model";

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
  codex: "codex login",
};

export type CliAgentStatus = "authorized" | "unauthorized" | "not_found";

export function cliAgentStatus(agent: AvailableAgent): CliAgentStatus {
  if (agent.authStatus === "not_found") return "not_found";
  if (agent.authStatus === "authorized") return "authorized";
  return "unauthorized";
}

export function cliAgentName(agent: AvailableAgent) {
  if (agent.name === "claude") return "Claude Code";
  if (agent.name === "codex") return "Codex";
  return agent.name;
}

export function CliAgentStatusBadge({ agent }: { agent: AvailableAgent }) {
  const version = agent.version || "—";
  switch (cliAgentStatus(agent)) {
    case "authorized":
      return (
        <Badge variant="secondary">
          {m.settings_space_cli_found_auth({ version })}
        </Badge>
      );
    case "unauthorized":
      return (
        <Badge variant="outline">
          {m.settings_space_cli_found_noauth({ version })}
        </Badge>
      );
    case "not_found":
      return (
        <Badge variant="destructive">{m.settings_space_cli_not_found()}</Badge>
      );
  }
}

// What the user can do about the agent's state: sign in or install it.
export function cliAgentNextStep(agent: AvailableAgent) {
  const status = cliAgentStatus(agent);
  if (status === "unauthorized" && CLI_AUTH_COMMANDS[agent.name])
    return m.settings_space_cli_noauth_hint({
      command: CLI_AUTH_COMMANDS[agent.name],
    });
  if (status === "not_found")
    return (
      <Button asChild variant="link" size="sm" className="h-auto p-0">
        <a href={agent.docsUrl} target="_blank" rel="noopener noreferrer">
          {m.settings_space_cli_install()}
          <ArrowUpRight data-icon="inline-end" />
        </a>
      </Button>
    );
  return null;
}
