import { Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages.js";

export function SearchControl({
  open,
  query,
  onOpenChange,
  onQueryChange,
}: {
  open: boolean;
  query: string;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
}) {
  function openSearch() {
    if (!open) onOpenChange(true);
  }

  return (
    <InputGroup
      role={open ? "group" : "button"}
      tabIndex={open ? undefined : 0}
      aria-label={m.collection_search_placeholder()}
      onClick={openSearch}
      onKeyDown={(event) => {
        if (!open && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpenChange(true);
        }
      }}
      className={cn(
        "h-7 flex-none overflow-hidden rounded-md bg-background shadow-none transition-[width,background-color,border-color] duration-150 ease-out has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20",
        open
          ? "w-56 border-border"
          : "w-7 cursor-pointer border-transparent bg-transparent hover:bg-accent",
      )}
    >
      <InputGroupAddon className={cn("py-0", open ? "pl-2 pr-1" : "px-1.5")}>
        <Search />
      </InputGroupAddon>
      {open ? (
        <>
          <InputGroupInput
            autoFocus
            className="h-7 px-0 text-sm"
            value={query}
            placeholder={m.collection_search_placeholder()}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onQueryChange("");
                onOpenChange(false);
              }
            }}
          />
          <InputGroupAddon align="inline-end" className="py-0 pl-1 pr-1.5">
            <InputGroupButton
              size="icon-xs"
              className="size-5"
              aria-label={m.project_cancel()}
              onClick={() => {
                onQueryChange("");
                onOpenChange(false);
              }}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        </>
      ) : null}
    </InputGroup>
  );
}
