import type { TerminalDropOverlayState } from "@/features/terminal/hooks/use-terminal-drop";
import * as m from "@/paraglide/messages.js";

interface TerminalDropOverlayProps {
  state: TerminalDropOverlayState;
}

export function TerminalDropOverlay({ state }: TerminalDropOverlayProps) {
  if (!state) return null;

  return (
    <div
      className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-md border border-dashed bg-background/85 px-4 text-center text-sm shadow-sm backdrop-blur-sm"
      aria-live="polite"
    >
      <span className={state.kind === "error" ? "text-destructive" : undefined}>
        {state.kind === "error"
          ? m.terminal_drop_error()
          : state.count === 1
            ? m.terminal_drop_insert_path()
            : m.terminal_drop_insert_paths({ count: state.count })}
      </span>
    </div>
  );
}
