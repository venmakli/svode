import { Fragment } from "react";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  NavigationMenuItems,
  type NavigationItem,
} from "@/features/navigation";
import type {
  ContentAction,
  ContentActionGroup,
  ContentActionId,
} from "../model/catalog";
import { CONTENT_ACTION_PRESENTATION } from "./content-action-presentation";

export type ContentActionHandlers = Partial<
  Record<Exclude<ContentActionId, "pin">, () => void>
>;

/**
 * The items of an object's dropdown menu, built from its catalog groups and
 * separated by group. Pin items come from the navigation model of `pinItem`.
 */
export function ContentActionMenuItems({
  groups,
  pinItem = null,
  handlers,
}: {
  groups: readonly ContentActionGroup[];
  pinItem?: NavigationItem | null;
  handlers: ContentActionHandlers;
}) {
  const shown = groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter(
        (action) => action.id !== "pin" || pinItem !== null,
      ),
    }))
    .filter((group) => group.actions.length > 0);

  return shown.map((group, index) => (
    <Fragment key={group.id}>
      {index > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuGroup data-content-action-group={group.id}>
        {group.actions.map((action) =>
          action.id === "pin" ? (
            <NavigationMenuItems key="pin" item={pinItem} />
          ) : (
            <ContentActionMenuItem
              key={action.id}
              action={action}
              id={action.id}
              onSelect={handlers[action.id]}
            />
          ),
        )}
      </DropdownMenuGroup>
    </Fragment>
  ));
}

function ContentActionMenuItem({
  action,
  id,
  onSelect,
}: {
  action: ContentAction;
  id: Exclude<ContentActionId, "pin">;
  onSelect: (() => void) | undefined;
}) {
  const presentation = CONTENT_ACTION_PRESENTATION[id];
  const Icon = presentation.icon;
  const label = presentation.label();
  return (
    <DropdownMenuItem
      variant={presentation.destructive ? "destructive" : "default"}
      disabled={action.disabled}
      data-content-action={id}
      onSelect={() => onSelect?.()}
    >
      <Icon data-icon="inline-start" />
      {action.reason ? (
        <span className="flex min-w-0 flex-col">
          {label}
          <span className="text-xs text-muted-foreground">{action.reason}</span>
        </span>
      ) : (
        label
      )}
    </DropdownMenuItem>
  );
}
