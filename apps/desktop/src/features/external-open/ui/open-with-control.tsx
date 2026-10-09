import { Fragment } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import type { OpenWithGroup } from "../model/types";

export interface OpenWithControlProps {
  /** The first group gives the primary button; the menu lists all in order. */
  groups: readonly [OpenWithGroup, ...OpenWithGroup[]];
  /**
   * `icon` for toolbars; `text` for viewer states, where the button keeps the
   * visual role of the action it replaces.
   */
  presentation?: "icon" | "text";
  variant?: "default" | "outline";
}

/** Split control: run the primary action, or choose another from the menu. */
export function OpenWithControl({
  groups,
  presentation = "icon",
  variant = "outline",
}: OpenWithControlProps) {
  const primary = groups[0].primary;
  const pending = groups.some((group) => group.pending);
  const text = presentation === "text";

  const primaryButton = (
    <Button
      type="button"
      variant={variant}
      size={text ? "default" : "icon-sm"}
      aria-label={text ? undefined : primary.label}
      disabled={pending}
      data-external-open-primary
      onClick={() => primary.run()}
    >
      {primary.renderIcon(text ? "inline-start" : undefined)}
      {text ? <span className="truncate">{primary.label}</span> : null}
    </Button>
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) groups.forEach((group) => group.onMenuOpen?.());
      }}
    >
      <ButtonGroup className={text ? "max-w-full min-w-0" : "shrink-0"}>
        {text ? (
          primaryButton
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{primaryButton}</TooltipTrigger>
            <TooltipContent side="bottom">{primary.label}</TooltipContent>
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
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <DropdownMenuSeparator data-open-with-group-separator />
            ) : null}
            {group.items}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
