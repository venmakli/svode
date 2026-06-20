import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Pencil } from "lucide-react";

interface SpaceInstructionsSectionProps {
  agentsMdContent: string | null;
  enabledClis: string[];
  onOpenAgentsMd: () => void;
}

export function SpaceInstructionsSection({
  agentsMdContent,
  enabledClis,
  onOpenAgentsMd,
}: SpaceInstructionsSectionProps) {
  const agentsMdLines = agentsMdContent?.split("\n").length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {agentsMdContent !== null ? (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">
                {enabledClis.includes("claude")
                  ? m.settings_space_agents_md_symlink({
                      target: "CLAUDE.md",
                    })
                  : "AGENTS.md"}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {m.settings_space_agents_md_lines({
                    count: String(agentsMdLines),
                  })}
                </span>
                <Button variant="ghost" size="sm" onClick={onOpenAgentsMd}>
                  <Pencil data-icon="inline-start" />
                  {m.settings_space_agents_md_open()}
                </Button>
              </div>
            </div>
            <pre className="text-xs font-mono bg-muted/50 rounded p-2 max-h-[200px] overflow-y-auto whitespace-pre-wrap">
              {agentsMdContent}
            </pre>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" onClick={onOpenAgentsMd}>
          {m.settings_space_agents_md_create()}
        </Button>
      )}
    </div>
  );
}
