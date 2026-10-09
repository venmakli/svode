import { FolderOpen } from "lucide-react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import * as m from "@/paraglide/messages.js";

import type { ExternalOpenBinding, OpenWithGroup } from "../model/types";
import { revealInFileManagerLabel } from "../model/reveal-label";
import { ExternalAppIcon } from "../ui/external-app-icon";
import { useExternalOpen } from "./use-external-open";

/** The applications of one target as a group of an "Open with" control. */
export function useExternalOpenGroup({
  target,
  onError,
}: ExternalOpenBinding): OpenWithGroup {
  const {
    apps,
    withoutDefault,
    primary,
    pending,
    refresh,
    openPrimary,
    choose,
    reveal,
  } = useExternalOpen(target, onError);

  return {
    primary: {
      label: primary
        ? m.external_open_in({ name: primary.label })
        : m.external_open_default(),
      renderIcon: (dataIcon) => (
        <ExternalAppIcon app={primary} data-icon={dataIcon} />
      ),
      run: () => void openPrimary(),
    },
    pending,
    onMenuOpen: refresh,
    items: (
      <>
        <DropdownMenuGroup>
          {withoutDefault ? (
            <DropdownMenuItem
              disabled={pending}
              data-external-app-system
              onSelect={() => void choose(null)}
            >
              <ExternalAppIcon app={null} className="size-5" />
              <span className="min-w-0 truncate">
                {m.external_open_default()}
              </span>
            </DropdownMenuItem>
          ) : null}
          {apps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              disabled={pending}
              data-external-app={app.id}
              onSelect={() => void choose(app)}
            >
              <ExternalAppIcon app={app} className="size-5" />
              <span className="min-w-0 truncate">{app.label}</span>
              {app.isDefault ? (
                <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                  {m.external_open_default_marker()}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {reveal ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={pending}
                data-external-open-reveal
                onSelect={() => void reveal()}
              >
                <FolderOpen aria-hidden className="size-5 shrink-0" />
                <span className="min-w-0 truncate">
                  {revealInFileManagerLabel()}
                </span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </>
    ),
  };
}
