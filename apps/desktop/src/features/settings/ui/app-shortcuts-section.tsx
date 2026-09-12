import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isMacKeyboardPlatform } from "@/shared/lib/keyboard-shortcuts";
import {
  shortcutKeys,
  shortcutKeyGlyph,
  shortcutKeyName,
  type ShortcutGroup,
} from "@/shared/lib/shortcut-description";

export function AppShortcutsSection({
  groups,
}: {
  groups: readonly ShortcutGroup[];
}) {
  const mac = isMacKeyboardPlatform();
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-6">
      {groups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`shortcuts-${group.id}`}
          className="flex min-w-0 flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <h2 id={`shortcuts-${group.id}`} className="text-sm font-medium">
              {group.label()}
            </h2>
            {group.context && (
              <p className="text-xs text-muted-foreground">{group.context()}</p>
            )}
          </div>
          <dl className="flex min-w-0 flex-col gap-3">
            {group.commands.map((command) => (
              <div
                key={command.id}
                data-shortcut={command.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1"
              >
                <dt className="min-w-0 flex-1 basis-40 text-sm wrap-break-word">
                  {command.label()}
                  {command.context && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {command.context()}
                    </p>
                  )}
                </dt>
                <dd className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
                  {shortcutKeys(command, mac).map((keys, index) => (
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
                        {keys
                          .map((key) => shortcutKeyName(key, mac))
                          .join(" + ")}
                      </span>
                      <KbdGroup aria-hidden="true">
                        {keys.map((key) => (
                          <Kbd key={key}>{shortcutKeyGlyph(key, mac)}</Kbd>
                        ))}
                      </KbdGroup>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
