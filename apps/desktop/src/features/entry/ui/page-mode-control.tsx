import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";

import type { PageSurfaceMode } from "../model/page-surface";
import { usePageSurfaceSession } from "../hooks/page-surface-context";

export function PageModeControl() {
  const session = usePageSurfaceSession();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={session.currentMode}
      aria-label={m.page_surface_mode_label()}
      aria-busy={session.modePending}
      data-page-mode-control
      onValueChange={(value) => {
        if (value) void session.requestMode(value as PageSurfaceMode);
      }}
    >
      {session.contributions.map((contribution) => (
        <ToggleGroupItem
          key={contribution.id}
          value={contribution.id}
          disabled={session.modePending}
          aria-label={contribution.label}
        >
          {contribution.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
