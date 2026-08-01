import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import * as m from "@/paraglide/messages.js";

import type { ActorCatalogRow } from "../model/types";
import { ActorAvatar } from "./actor-avatar";

export function ActorMergePicker({
  pending,
  rows,
  selectedEmail,
  onSelect,
}: {
  pending: boolean;
  rows: readonly ActorCatalogRow[];
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
            {rows.map((row) => (
              <CommandItem
                key={row.canonicalEmail}
                disabled={pending}
                value={`${row.displayName} ${row.canonicalEmail}`}
                data-checked={selectedEmail === row.canonicalEmail}
                onSelect={() => onSelect(row.canonicalEmail)}
              >
                <ActorAvatar actor={row} size="sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{row.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.canonicalEmail}
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
