import { ChevronDown } from "lucide-react";

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

import { useExternalOpen } from "../hooks/use-external-open";
import type { ExternalApp, ExternalOpenTarget } from "../model/types";
import { ExternalAppIcon } from "./external-app-icon";

interface ExternalOpenButtonProps {
  target: ExternalOpenTarget;
  onError(error: unknown, app: ExternalApp | null): void;
}

/** Split control: open in the primary application, or choose another one. */
export function ExternalOpenButton({
  target,
  onError,
}: ExternalOpenButtonProps) {
  const { apps, primary, pending, refresh, openPrimary, openApp } =
    useExternalOpen(target, onError);
  const primaryLabel = primary
    ? m.external_open_in({ name: primary.label })
    : m.external_open_default();

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={primaryLabel}
              disabled={pending}
              data-external-open-primary
              onClick={() => void openPrimary()}
            >
              <ExternalAppIcon app={primary} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{primaryLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={m.external_open_with()}
                disabled={pending}
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {m.external_open_with()}
          </TooltipContent>
        </Tooltip>
      </ButtonGroup>
      <DropdownMenuContent align="end" className="max-w-72 min-w-44">
        <DropdownMenuGroup>
          {apps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              disabled={pending}
              data-external-app={app.id}
              onSelect={() => void openApp(app)}
            >
              <ExternalAppIcon app={app} className="size-5" />
              <span className="min-w-0 truncate">{app.label}</span>
              {app.isDefault ? (
                <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                  {m.external_open_default_marker()}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
