import type { ResourceDropOverlayState } from "../hooks/use-resource-drop-target";

/**
 * The highlight over a surface while files or resources are dragged onto
 * it: a dashed frame with the label in the middle, in the error color when
 * the drop is refused or failed.
 */
export function ResourceDropOverlay({
  state,
  label,
}: {
  state: ResourceDropOverlayState;
  /** What the surface says for this state. */
  label: string;
}) {
  if (!state) return null;
  const failed = state.kind !== "active";
  return (
    <div
      className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border border-dashed bg-background/85 px-4 text-center text-sm shadow-sm backdrop-blur-sm"
      aria-live="polite"
    >
      <span className={failed ? "text-destructive" : undefined}>{label}</span>
    </div>
  );
}
