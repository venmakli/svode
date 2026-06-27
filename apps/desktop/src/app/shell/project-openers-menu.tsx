import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, Code2, FolderOpen, SquareTerminal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as m from "@/paraglide/messages.js";
import {
  TerminalPrimaryAction,
  type TerminalTarget,
} from "@/features/terminal";
import { getNativeErrorMessage } from "@/platform/native/errors";
import {
  listProjectOpeners,
  openProjectInTool,
  type ProjectOpener,
} from "./api/project-openers";

interface ProjectOpenersMenuProps {
  projectPath: string | null;
  terminalTarget: TerminalTarget | null;
}

export function ProjectOpenersMenu({
  projectPath,
  terminalTarget,
}: ProjectOpenersMenuProps) {
  const [openers, setOpeners] = useState<ProjectOpener[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!projectPath) {
      setOpeners([]);
      return;
    }

    listProjectOpeners()
      .then((items) => {
        if (!cancelled) setOpeners(items);
      })
      .catch((error) => {
        console.error("Failed to list project openers:", error);
        if (!cancelled) setOpeners([]);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (!projectPath) return null;

  const isOpening = openingId !== null;
  const dropdownDisabled = isOpening || openers.length === 0;

  async function handleOpen(opener: ProjectOpener) {
    if (!projectPath || openingId) return;

    setOpeningId(opener.id);
    try {
      await openProjectInTool(projectPath, opener.id);
    } catch (error) {
      console.error(`Failed to open project in ${opener.label}:`, error);
      toast.error(m.project_openers_error({ name: opener.label }), {
        description: getNativeErrorMessage(error),
      });
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <DropdownMenu>
      <ButtonGroup>
        <TerminalPrimaryAction target={terminalTarget} />
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={m.project_openers_tooltip()}
            disabled={dropdownDisabled}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
      </ButtonGroup>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          {openers.map((opener) => {
            const Icon = iconForOpener(opener);
            return (
              <DropdownMenuItem
                key={opener.id}
                disabled={isOpening}
                onSelect={() => void handleOpen(opener)}
              >
                <Icon />
                <span>{opener.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function iconForOpener(opener: ProjectOpener): LucideIcon {
  switch (opener.kind) {
    case "file_manager":
      return FolderOpen;
    case "terminal":
      return SquareTerminal;
    case "editor":
    default:
      return Code2;
  }
}
