import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import * as m from "@/paraglide/messages.js";

import type { ActorCatalogItem } from "../model/types";
import { ActorAvatar } from "./actor-avatar";

export function ActorMergePicker({
  pending,
  items,
  selectedEmail,
  onSelect,
}: {
  pending: boolean;
  items: readonly ActorCatalogItem[];
  selectedEmail: string | null;
  onSelect(canonicalEmail: string): void;
}) {
  return (
    <div className="h-64 overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <Command>
        <CommandInput
          autoFocus
          disabled={pending}
          placeholder={m.actors_mutation_merge_search()}
        />
        <CommandList>
          <CommandEmpty>{m.actors_mutation_merge_empty()}</CommandEmpty>
          <CommandGroup heading={m.actors_mutation_merge_target_label()}>
            {items.map((item) => (
              <CommandItem
                key={item.canonicalEmail}
                disabled={pending}
                value={`${item.displayName} ${item.canonicalEmail}`}
                data-checked={selectedEmail === item.canonicalEmail}
                onSelect={() => onSelect(item.canonicalEmail)}
              >
                <ActorAvatar actor={item} size="sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.canonicalEmail}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
