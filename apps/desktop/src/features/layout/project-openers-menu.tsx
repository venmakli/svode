import { useEffect, useMemo, useState } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import {
  listProjectOpeners,
  openProjectInTool,
  type ProjectOpener,
} from "./api/project-openers";

interface ProjectOpenersMenuProps {
  projectPath: string | null;
}

export function ProjectOpenersMenu({ projectPath }: ProjectOpenersMenuProps) {
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

  const primaryOpener = useMemo(() => {
    return (
      openers.find((opener) => opener.id === "vscode") ??
      openers.find((opener) => opener.kind === "editor") ??
      openers.find((opener) => opener.kind === "file_manager") ??
      openers[0] ??
      null
    );
  }, [openers]);

  if (!projectPath || openers.length === 0) return null;

  const PrimaryIcon = primaryOpener ? iconForOpener(primaryOpener) : Code2;
  const isOpening = openingId !== null;
  const primaryLabel = primaryOpener
    ? m.project_openers_open_in({ name: primaryOpener.label })
    : m.project_openers_tooltip();

  async function handleOpen(opener: ProjectOpener) {
    if (!projectPath || openingId) return;

    setOpeningId(opener.id);
    try {
      await openProjectInTool(projectPath, opener.id);
    } catch (error) {
      console.error(`Failed to open project in ${opener.label}:`, error);
      toast.error(m.project_openers_error({ name: opener.label }));
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <DropdownMenu>
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={primaryLabel}
              disabled={!primaryOpener || isOpening}
              onClick={() => {
                if (primaryOpener) void handleOpen(primaryOpener);
              }}
            >
              <PrimaryIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{primaryLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={m.project_openers_tooltip()}
            disabled={isOpening}
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
