import { Folder, FolderGit2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import type { TerminalTarget } from "@/features/terminal/model/types";
import * as m from "@/paraglide/messages.js";

interface TerminalTargetMenuProps {
  project: TerminalTarget | null;
  spaces: TerminalTarget[];
}

export function TerminalTargetMenu({
  project,
  spaces,
}: TerminalTargetMenuProps) {
  const createTab = useTerminalStore((state) => state.createTab);
  const hasTargets = Boolean(project) || spaces.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.terminal_new_tab()}
          disabled={!hasTargets}
        >
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          {project && (
            <DropdownMenuItem onSelect={() => void createTab(project)}>
              <FolderGit2 />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{project.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {project.secondaryPath}
                </span>
              </div>
            </DropdownMenuItem>
          )}
          {project && spaces.length > 0 && <DropdownMenuSeparator />}
          {spaces.map((space) => (
            <DropdownMenuItem
              key={space.scopeId}
              onSelect={() => void createTab(space)}
            >
              <Folder />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{space.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {space.secondaryPath}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
