import {
  ResourceDropOverlay,
  type ResourceDropOverlayState,
} from "@/features/space/resource-drag";
import * as m from "@/paraglide/messages.js";

interface TerminalDropOverlayProps {
  state: ResourceDropOverlayState;
}

export function TerminalDropOverlay({ state }: TerminalDropOverlayProps) {
  if (!state) return null;
  return (
    <ResourceDropOverlay
      state={state}
      label={
        state.kind !== "active"
          ? m.terminal_drop_error()
          : state.count === 1
            ? m.terminal_drop_insert_path()
            : m.terminal_drop_insert_paths({ count: state.count })
      }
    />
  );
}
