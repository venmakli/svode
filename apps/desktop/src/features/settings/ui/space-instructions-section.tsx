import { useState } from "react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Pencil } from "lucide-react";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
} from "./settings-layout";

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
  const [open, setOpen] = useState(false);
  if (agentsMdContent === null)
    return (
      <SettingsGroup>
        <Empty className="p-6">
          <EmptyHeader>
            <EmptyTitle>{m.settings_space_agents_md_empty()}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={onOpenAgentsMd}>
              {m.settings_space_agents_md_create()}
            </Button>
          </EmptyContent>
        </Empty>
      </SettingsGroup>
    );
  return (
    <SettingsGroup>
      <Collapsible open={open} onOpenChange={setOpen}>
        <SettingsItem
          title={
            enabledClis.includes("claude")
              ? m.settings_space_agents_md_symlink({ target: "CLAUDE.md" })
              : "AGENTS.md"
          }
          description={m.settings_space_agents_md_lines({
            count: String(agentsMdContent.split("\n").length),
          })}
          actions={
            <>
              <SettingsDisclosureTrigger
                open={open}
                label={
                  open
                    ? m.settings_space_agents_md_hide()
                    : m.settings_space_agents_md_show()
                }
              />
              <Button variant="outline" size="sm" onClick={onOpenAgentsMd}>
                <Pencil data-icon="inline-start" />
                {m.settings_space_agents_md_open()}
              </Button>
            </>
          }
        >
          <CollapsibleContent className="basis-full">
            <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap wrap-break-word">
              {agentsMdContent}
            </pre>
          </CollapsibleContent>
        </SettingsItem>
      </Collapsible>
    </SettingsGroup>
  );
}
