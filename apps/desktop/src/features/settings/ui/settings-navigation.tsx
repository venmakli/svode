import type { ComponentType } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingsDestination } from "../model/settings-destination";

export interface SettingsNavigationGroup {
  label: string;
  items: {
    label: string;
    icon: ComponentType<{ className?: string }>;
    destination: SettingsDestination;
  }[];
}

function itemKey(destination: SettingsDestination) {
  return `${destination.scope}:${destination.section}`;
}

export function SettingsNavigation({
  groups,
  destination,
  onNavigate,
}: {
  groups: SettingsNavigationGroup[];
  destination: SettingsDestination;
  onNavigate: (destination: SettingsDestination) => void;
}) {
  const value = itemKey(destination);
  return (
    <>
      <div className="min-w-0 shrink-0 border-b p-3 pr-12 md:hidden">
        <Select
          value={value}
          onValueChange={(key) => {
            const item = groups
              .flatMap((group) => group.items)
              .find((item) => itemKey(item.destination) === key);
            if (item) onNavigate(item.destination);
          }}
        >
          <SelectTrigger
            className="w-full min-w-0"
            aria-label={m.settings_title()}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]"
          >
            {groups.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel
                  className="max-w-full truncate"
                  title={group.label}
                >
                  {group.label}
                </SelectLabel>
                {group.items.map((item) => (
                  <SelectItem
                    key={itemKey(item.destination)}
                    value={itemKey(item.destination)}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Sidebar
        collapsible="none"
        className="hidden h-full w-[220px] shrink-0 md:flex"
      >
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel
                className="block truncate leading-8"
                title={group.label}
              >
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={itemKey(item.destination)}>
                      <SidebarMenuButton
                        isActive={value === itemKey(item.destination)}
                        onClick={() => onNavigate(item.destination)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
    </>
  );
}
