import { Fragment } from "react";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  NavigationMenuItems,
  type NavigationItem,
  type NavigationMenuKind,
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

const MENU_PRIMITIVES = {
  dropdown: {
    Group: DropdownMenuGroup,
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
  },
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
  },
} as const;

/**
 * The items of an object's dropdown or context menu, built from its catalog
 * groups and separated by group. Pin items come from the navigation model of
 * `pinItem`.
 */
export function ContentActionMenuItems({
  groups,
  pinItem = null,
  handlers,
  menu = "dropdown",
}: {
  groups: readonly ContentActionGroup[];
  pinItem?: NavigationItem | null;
  handlers: ContentActionHandlers;
  menu?: NavigationMenuKind;
}) {
  const { Group, Separator } = MENU_PRIMITIVES[menu];
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
      {index > 0 ? <Separator /> : null}
      <Group data-content-action-group={group.id}>
        {group.actions.map((action) =>
          action.id === "pin" ? (
            <NavigationMenuItems key="pin" item={pinItem} menu={menu} />
          ) : (
            <ContentActionMenuItem
              key={action.id}
              action={action}
              id={action.id}
              menu={menu}
              onSelect={handlers[action.id]}
            />
          ),
        )}
      </Group>
    </Fragment>
  ));
}

function ContentActionMenuItem({
  action,
  id,
  menu,
  onSelect,
}: {
  action: ContentAction;
  id: Exclude<ContentActionId, "pin">;
  menu: NavigationMenuKind;
  onSelect: (() => void) | undefined;
}) {
  const { Item } = MENU_PRIMITIVES[menu];
  const presentation = CONTENT_ACTION_PRESENTATION[id];
  const Icon = presentation.icon;
  const label = presentation.label();
  return (
    <Item
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
    </Item>
  );
}
