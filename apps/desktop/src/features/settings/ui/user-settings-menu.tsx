import { useRef } from "react";
import { Monitor, Moon, Palette, Settings, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";
import { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";

interface UserSettingsMenuProps {
  identityName: string | null;
  identityEmail: string | null;
  identityAvatarColor: string;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}

export function UserSettingsMenu({
  identityName,
  identityEmail,
  identityAvatarColor,
  onOpenProfile,
  onOpenSettings,
}: UserSettingsMenuProps) {
  const destination = useRef<(() => void) | null>(null);
  const { theme, themePending, handleThemeChange } = useAppSettingsAppearance();
  const userName = identityName || "User";
  const initials = userName
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const shortcut = /Mac/i.test(navigator.platform) ? "⌘," : "Ctrl+,";
  const modes = [
    { value: "light", label: m.common_theme_light(), icon: Sun },
    { value: "dark", label: m.common_theme_dark(), icon: Moon },
    { value: "system", label: m.common_theme_system(), icon: Monitor },
  ];

  function avatar(compact: boolean) {
    return (
      <Avatar
        className={
          compact
            ? "size-6 rounded-lg after:rounded-lg"
            : "size-8 rounded-lg after:rounded-lg"
        }
      >
        <AvatarFallback
          className="rounded-lg text-xs font-medium text-white"
          style={{ backgroundColor: identityAvatarColor }}
        >
          {initials}
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton>
              {avatar(true)}
              <span className="truncate">{userName}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-64 max-w-[calc(100vw-1rem)]"
            onCloseAutoFocus={(event) => {
              const openSettings = destination.current;
              destination.current = null;
              if (openSettings) {
                event.preventDefault();
                openSettings();
              }
            }}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem
                textValue={userName}
                onSelect={() => {
                  destination.current = onOpenProfile;
                }}
              >
                {avatar(false)}
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-medium">{userName}</span>
                  <span className="truncate text-xs">
                    {identityEmail ?? ""}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => {
                  destination.current = onOpenSettings;
                }}
              >
                <Settings />
                {m.settings_title()}
                <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup
              className="flex items-center justify-between gap-2 px-1.5 py-1"
              aria-label={m.settings_theme_label()}
            >
              <span className="flex items-center gap-1.5 text-sm">
                <Palette className="size-4 shrink-0" aria-hidden="true" />
                {m.settings_theme_label()}
              </span>
              <ToggleGroup
                type="single"
                size="sm"
                value={theme}
                onValueChange={handleThemeChange}
                disabled={themePending}
                rovingFocus={false}
                aria-label={m.settings_theme_label()}
                aria-busy={themePending}
              >
                {modes.map((mode) => (
                  <DropdownMenuItem
                    key={mode.value}
                    asChild
                    disabled={themePending}
                    textValue={mode.label}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <ToggleGroupItem
                      value={mode.value}
                      role="menuitemradio"
                      aria-checked={theme === mode.value}
                      aria-label={mode.label}
                      title={mode.label}
                    >
                      <mode.icon />
                    </ToggleGroupItem>
                  </DropdownMenuItem>
                ))}
              </ToggleGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
