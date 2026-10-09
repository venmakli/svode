import type { ReactNode } from "react";
import { LoaderCircle, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { ViewToolsGroup } from "./view-tools-group";

/**
 * The top bar of every peek: `[identity] ⓘ ⋯ ··· [view tools] · Changes ·
 * Open with · Expand · ×`. A peek fills the slots it has; the order is the
 * bar's, and absent slots leave no gap.
 */
export function PeekTopBar({
  identity,
  info,
  menu,
  viewTools,
  changes,
  openWith,
  onExpand,
  expandDisabled = false,
  onClose,
  closePending = false,
}: {
  /** Icon and name of the open object, see `PeekIdentity`. */
  identity?: ReactNode;
  /** The ⓘ details of the object. */
  info?: ReactNode;
  /** The ⋯ menu of the object. */
  menu?: ReactNode;
  viewTools?: ReactNode;
  changes?: ReactNode;
  openWith?: ReactNode;
  /** Opens the object in the main area; without it the peek has no Expand. */
  onExpand?: (() => void) | null;
  expandDisabled?: boolean;
  onClose(): void;
  /** A close guard is running: × waits disabled. */
  closePending?: boolean;
}) {
  return (
    <div
      data-peek-top-bar
      className="flex min-h-9 shrink-0 items-center gap-1 px-2 pb-2"
    >
      <div className="flex min-w-0 shrink-[10000] items-center gap-1">
        {identity}
        {info}
        {menu}
      </div>
      {viewTools ? (
        <ViewToolsGroup>{viewTools}</ViewToolsGroup>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex shrink-0 items-center gap-1">
        {changes}
        {openWith}
        {onExpand ? (
          <PeekExpandButton disabled={expandDisabled} onClick={onExpand} />
        ) : null}
        <PeekCloseButton pending={closePending} onClick={onClose} />
      </div>
    </div>
  );
}

/** The object of a peek: its icon or fallback and its name, not a link. */
export function PeekIdentity({
  icon,
  name,
}: {
  icon: ReactNode;
  name: string;
}) {
  return (
    <div data-peek-identity className="flex min-w-0 items-center gap-2 px-1">
      <span
        className="flex size-4 shrink-0 items-center justify-center leading-none text-muted-foreground [&_svg]:size-4"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium" title={name}>
        {name}
      </span>
    </div>
  );
}

export function PeekExpandButton({
  disabled = false,
  onClick,
}: {
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <PeekIconButton
      label={m.peek_expand()}
      disabled={disabled}
      onClick={onClick}
    >
      <Maximize2 />
    </PeekIconButton>
  );
}

export function PeekCloseButton({
  pending = false,
  onClick,
}: {
  pending?: boolean;
  onClick(): void;
}) {
  return (
    <PeekIconButton label={m.peek_close()} disabled={pending} onClick={onClick}>
      {pending ? <LoaderCircle className="animate-spin" /> : <X />}
    </PeekIconButton>
  );
}

function PeekIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
