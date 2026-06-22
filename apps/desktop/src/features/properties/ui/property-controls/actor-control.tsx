import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/shared/lib/utils";
import {
  actorCommitCount,
  actorDisplayName,
  actorIsMe,
  actorLastCommitAt,
  gravatarUrl,
  hashIndex,
  initialsForActor,
  isValidEmail,
  normalizeActorValues,
  resolveActorCandidate,
} from "../../lib/utils";
import type { ActorCandidate, Column } from "../../model/types";
import * as m from "@/paraglide/messages.js";
import { deferStateUpdate, useAutoOpen } from "./common";
import type { PropertyControlProps } from "./types";

export function ActorControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  actors = [],
  onRequestActors,
  onChange,
  onOpenChange,
}: Pick<
  PropertyControlProps,
  | "value"
  | "invalid"
  | "disabled"
  | "actors"
  | "onRequestActors"
  | "onChange"
  | "autoOpen"
  | "onOpenChange"
> & { column: Column }) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const multiple = Boolean(column.multiple);
  const emails = multiple
    ? normalizeActorValues(value)
    : typeof value === "string" && value
      ? [value.trim().toLowerCase()]
      : [];
  const selected = emails.map((email) => resolveActorCandidate(email, actors));
  const selectedSet = new Set(emails);
  const [allTime, setAllTime] = useState(column.display === "all_time");
  const [freeform, setFreeform] = useState("");

  useEffect(() => {
    return deferStateUpdate(() => {
      const sourceAllTime = column.display === "all_time";
      setAllTime(sourceAllTime);
      if (sourceAllTime) void onRequestActors?.(true);
    });
  }, [column.display, onRequestActors]);

  const sortedActors = useMemo(() => {
    const me = actors.filter(actorIsMe);
    const recent = actors
      .filter((actor) => !actorIsMe(actor))
      .sort((a, b) => (actorLastCommitAt(b) ?? 0) - (actorLastCommitAt(a) ?? 0))
      .slice(0, 5);
    const recentSet = new Set(recent.map((actor) => actor.email));
    const all = actors
      .filter((actor) => !actorIsMe(actor) && !recentSet.has(actor.email))
      .sort((a, b) => actorDisplayName(a).localeCompare(actorDisplayName(b)));
    return { me, recent, all };
  }, [actors]);

  const setActor = (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    if (!multiple) {
      void onChange(normalized);
      setOpen(false);
      return;
    }
    if (selectedSet.has(normalized)) {
      void onChange(emails.filter((item) => item !== normalized));
    } else {
      void onChange([...emails, normalized]);
    }
  };

  const addFreeform = () => {
    const email = freeform.trim().toLowerCase();
    if (!isValidEmail(email)) return;
    setActor(email);
    setFreeform("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "min-w-0 justify-start px-1.5",
            invalid && "ring-1 ring-warning",
          )}
        >
          {selected.length > 0 ? (
            multiple ? (
              <ActorStack actors={selected} />
            ) : (
              <ActorInline actor={selected[0]} />
            )
          ) : (
            <span className="text-muted-foreground">{m.property_empty()}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            value={freeform}
            onValueChange={setFreeform}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isValidEmail(freeform.trim())) {
                event.preventDefault();
                addFreeform();
              }
            }}
            placeholder={m.property_actor_search()}
          />
          <CommandList>
            <CommandEmpty>{m.property_no_options()}</CommandEmpty>
            <ActorGroup
              heading="Me"
              actors={sortedActors.me}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
            <ActorGroup
              heading="Recent"
              actors={sortedActors.recent}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
            <ActorGroup
              heading="All"
              actors={sortedActors.all}
              selectedEmails={selectedSet}
              multiple={multiple}
              onSelect={(actor) => setActor(actor.email)}
            />
          </CommandList>
          {multiple && selected.length > 0 ? (
            <div className="flex flex-wrap gap-1 border-t p-2">
              {selected.map((actor) => (
                <Button
                  key={actor.email}
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="min-w-0 max-w-full justify-start rounded-full px-2"
                  onClick={() =>
                    void onChange(
                      emails.filter((email) => email !== actor.email),
                    )
                  }
                >
                  <span className="truncate">{actorDisplayName(actor)}</span>
                  <X data-icon="inline-end" />
                </Button>
              ))}
            </div>
          ) : null}
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={!isValidEmail(freeform.trim())}
              onClick={addFreeform}
            >
              {m.property_actor_enter_to_assign()}
            </Button>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {m.property_actor_all_time()}
            </span>
            <Switch
              checked={allTime}
              onCheckedChange={(checked) => {
                setAllTime(checked);
                void onRequestActors?.(checked);
              }}
            />
          </div>
          <div className="border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => void onChange(null)}
            >
              {m.property_action_clear()}
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ActorGroup({
  heading,
  actors,
  selectedEmails,
  multiple,
  onSelect,
}: {
  heading: string;
  actors: ActorCandidate[];
  selectedEmails: Set<string>;
  multiple: boolean;
  onSelect: (actor: ActorCandidate) => void;
}) {
  if (actors.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {actors.map((actor) => (
        <CommandItem
          key={actor.email}
          data-checked={selectedEmails.has(actor.email.toLowerCase())}
          value={`${actor.name} ${actor.email}`}
          onSelect={() => onSelect(actor)}
        >
          {multiple ? (
            <Checkbox
              checked={selectedEmails.has(actor.email.toLowerCase())}
              className="pointer-events-none"
            />
          ) : null}
          <ActorAvatar actor={actor} />
          <span className="min-w-0 flex-1 truncate">
            {actorDisplayName(actor)}
          </span>
          {actorCommitCount(actor) === 0 ? (
            <span className="text-xs text-muted-foreground">new</span>
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function ActorStack({ actors }: { actors: ActorCandidate[] }) {
  return (
    <span className="inline-flex min-w-0 items-center">
      {actors.slice(0, 3).map((actor, index) => (
        <span key={actor.email} className={cn(index > 0 && "-ml-1.5")}>
          <ActorAvatar actor={actor} />
        </span>
      ))}
      {actors.length > 3 ? (
        <span className="ml-1 text-xs text-muted-foreground">
          +{actors.length - 3}
        </span>
      ) : null}
    </span>
  );
}

function ActorInline({ actor }: { actor: ActorCandidate }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={actor} />
      <span className="min-w-0 truncate">{actorDisplayName(actor)}</span>
    </span>
  );
}

function ActorAvatar({ actor }: { actor: ActorCandidate }) {
  const color = ["blue", "green", "purple", "orange", "pink"][
    hashIndex(actor.email, 5)
  ];
  return (
    <Avatar size="sm" className="shrink-0">
      <AvatarImage src={gravatarUrl(actor.email)} alt="" />
      <AvatarFallback
        className={cn(
          "text-[10px] font-medium",
          color === "blue" &&
            "bg-(--property-blue-soft) text-(--property-blue)",
          color === "green" &&
            "bg-(--property-green-soft) text-(--property-green)",
          color === "purple" &&
            "bg-(--property-purple-soft) text-(--property-purple)",
          color === "orange" &&
            "bg-(--property-orange-soft) text-(--property-orange)",
          color === "pink" &&
            "bg-(--property-pink-soft) text-(--property-pink)",
        )}
      >
        {initialsForActor(actor)}
      </AvatarFallback>
    </Avatar>
  );
}
