import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isMacKeyboardPlatform } from "@/shared/lib/keyboard-shortcuts";
import {
  shortcutKeys,
  shortcutKeyGlyph,
  shortcutKeyName,
  type ShortcutGroup,
} from "@/shared/lib/shortcut-description";
import { SettingsGroup, SettingsItem } from "./settings-layout";

export function AppShortcutsSection({
  groups,
}: {
  groups: readonly ShortcutGroup[];
}) {
  const mac = isMacKeyboardPlatform();
  return groups.map((group) => (
    <SettingsGroup
      key={group.id}
      title={group.label()}
      description={group.context?.()}
    >
      {group.commands.map((command) => (
        <SettingsItem
          key={command.id}
          data-shortcut={command.id}
          title={command.label()}
          description={command.context?.()}
          actions={shortcutKeys(command, mac).map((keys, index) => (
            <span
              key={keys.join("+")}
              className="inline-flex items-center gap-2"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className="text-xs text-muted-foreground"
                >
                  /
                </span>
              )}
              <span className="sr-only">
                {keys.map((key) => shortcutKeyName(key, mac)).join(" + ")}
              </span>
              <KbdGroup aria-hidden="true">
                {keys.map((key) => (
                  <Kbd key={key}>{shortcutKeyGlyph(key, mac)}</Kbd>
                ))}
              </KbdGroup>
            </span>
          ))}
        />
      ))}
    </SettingsGroup>
  ));
}
