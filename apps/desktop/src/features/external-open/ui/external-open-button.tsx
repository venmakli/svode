import { ChevronDown, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import { useExternalOpen } from "../hooks/use-external-open";
import type { ExternalOpenBinding } from "../model/types";
import { ExternalAppIcon } from "./external-app-icon";

interface ExternalOpenButtonProps extends ExternalOpenBinding {
  /**
   * `icon` for toolbars; `text` for viewer states, where the button keeps the
   * visual role of the action it replaces.
   */
  presentation?: "icon" | "text";
  variant?: "default" | "outline";
}

/** Split control: open in the primary application, or choose another one. */
export function ExternalOpenButton({
  target,
  onError,
  presentation = "icon",
  variant = "outline",
}: ExternalOpenButtonProps) {
  const {
    apps,
    withoutDefault,
    primary,
    pending,
    refresh,
    openPrimary,
    choose,
    reveal,
  } = useExternalOpen(target, onError);
  const primaryLabel = primary
    ? m.external_open_in({ name: primary.label })
    : m.external_open_default();
  const text = presentation === "text";

  const primaryButton = (
    <Button
      type="button"
      variant={variant}
      size={text ? "default" : "icon-sm"}
      aria-label={text ? undefined : primaryLabel}
      disabled={pending}
      data-external-open-primary
      onClick={() => void openPrimary()}
    >
      <ExternalAppIcon
        app={primary}
        data-icon={text ? "inline-start" : undefined}
      />
      {text ? <span className="truncate">{primaryLabel}</span> : null}
    </Button>
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <ButtonGroup className={text ? "max-w-full min-w-0" : "shrink-0"}>
        {text ? (
          primaryButton
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{primaryButton}</TooltipTrigger>
            <TooltipContent side="bottom">{primaryLabel}</TooltipContent>
          </Tooltip>
        )}
        {variant === "outline" ? null : <ButtonGroupSeparator />}
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant={variant}
                size={text ? "icon" : "icon-sm"}
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
          {withoutDefault ? (
            <DropdownMenuItem
              disabled={pending}
              data-external-app-system
              onSelect={() => void choose(null)}
            >
              <ExternalAppIcon app={null} className="size-5" />
              <span className="min-w-0 truncate">
                {m.external_open_default()}
              </span>
            </DropdownMenuItem>
          ) : null}
          {apps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              disabled={pending}
              data-external-app={app.id}
              onSelect={() => void choose(app)}
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
        {reveal ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={pending}
                data-external-open-reveal
                onSelect={() => void reveal()}
              >
                <FolderOpen aria-hidden className="size-5 shrink-0" />
                <span className="min-w-0 truncate">{revealLabel()}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function revealLabel() {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  if (platform.includes("mac")) return m.external_open_reveal_finder();
  if (platform.includes("win")) return m.external_open_reveal_explorer();
  return m.external_open_reveal_file_manager();
}
