import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { ModelOption } from "@/features/chat";
import type { AvailableAgent, SymlinkHealthReport } from "../model";

const CLI_AUTH_COMMANDS: Record<string, string> = {
  claude: "claude login",
};

interface SpaceAgentSectionProps {
  agents: AvailableAgent[];
  enabledClis: string[];
  defaultModel: string;
  systemPrompt: string;
  availableModels: ModelOption[];
  healthReport: SymlinkHealthReport | null;
  refreshing: boolean;
  onDefaultModelChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSystemPromptBlur: () => void;
  onCliToggle: (cliName: string, enabled: boolean) => void;
  onRefresh: () => void;
}

export function SpaceAgentSection({
  agents,
  enabledClis,
  defaultModel,
  systemPrompt,
  availableModels,
  healthReport,
  refreshing,
  onDefaultModelChange,
  onSystemPromptChange,
  onSystemPromptBlur,
  onCliToggle,
  onRefresh,
}: SpaceAgentSectionProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-sm flex-col gap-2">
        <Label>{m.settings_space_default_model()}</Label>
        <Select value={defaultModel} onValueChange={onDefaultModelChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableModels.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <span>{model.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {model.description}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {m.settings_space_default_model_desc()}
        </p>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>{m.settings_space_cli_agents()}</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? "animate-spin" : undefined}
            />
            {m.settings_space_cli_refresh()}
          </Button>
        </div>
        {agents.map((agent) => {
          const status = getCliStatus(agent);
          const isEnabled = enabledClis.includes(agent.name);
          const canEnable = status === "authorized";
          return (
            <div key={agent.name} className="flex items-start gap-3 py-2">
              <Checkbox
                checked={isEnabled}
                disabled={!canEnable}
                onCheckedChange={(checked) =>
                  onCliToggle(agent.name, checked === true)
                }
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium capitalize">
                  {agent.name === "claude"
                    ? "Claude Code"
                    : agent.name === "codex"
                      ? "Codex"
                      : agent.name}
                </span>
                <div className="mt-0.5">
                  {status === "authorized" && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      <span className="text-green-600 mr-1">&#10003;</span>
                      {m.settings_space_cli_found_auth({
                        version: agent.version || "unknown",
                      })}
                    </Badge>
                  )}
                  {status === "unauthorized" && (
                    <div className="flex flex-col gap-1">
                      <Badge
                        variant="secondary"
                        className="text-xs font-normal"
                      >
                        <span className="text-yellow-600 mr-1">&#9888;</span>
                        {m.settings_space_cli_found_noauth({
                          version: agent.version || "unknown",
                        })}
                      </Badge>
                      {CLI_AUTH_COMMANDS[agent.name] && (
                        <p className="text-xs text-muted-foreground">
                          {m.settings_space_cli_noauth_hint({
                            command: CLI_AUTH_COMMANDS[agent.name],
                          })}
                        </p>
                      )}
                    </div>
                  )}
                  {status === "not_found" && (
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="destructive"
                        className="text-xs font-normal"
                      >
                        <span className="mr-1">&#10005;</span>
                        {m.settings_space_cli_not_found()}
                      </Badge>
                      <a
                        href={agent.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {m.settings_space_cli_install()}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {healthReport && (
          <span className="text-xs text-muted-foreground">
            {healthReport.restored > 0
              ? m.settings_space_symlinks_restored({
                  count: String(healthReport.restored),
                })
              : m.settings_space_symlinks_ok()}
          </span>
        )}
      </div>

      <Separator />

      <div className="flex max-w-sm flex-col gap-2">
        <Label>{m.settings_system_prompt()}</Label>
        <Textarea
          value={systemPrompt}
          onChange={(event) => onSystemPromptChange(event.target.value)}
          onBlur={onSystemPromptBlur}
          placeholder={m.settings_system_prompt_placeholder()}
          rows={4}
        />
      </div>
    </div>
  );
}

function getCliStatus(
  agent: AvailableAgent,
): "authorized" | "unauthorized" | "not_found" {
  if (agent.authStatus === "not_found") return "not_found";
  if (agent.authStatus === "authorized") return "authorized";
  return "unauthorized";
}
