import { INDENT_WIDTH } from "../lib/tree-dnd-utilities";

interface TreeDropIndicatorProps {
  type: "before" | "after";
  relativeDepth: number; // 0 = same level, +1 = nest deeper, -1 = move shallower
}

export function TreeDropIndicator({ type, relativeDepth }: TreeDropIndicatorProps) {
  // Relative offset from this item's position
  // Positive = indent right (nesting deeper)
  // Negative = extend left (moving shallower)
  const offset = relativeDepth * INDENT_WIDTH;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
      style={{
        top: type === "before" ? -1 : undefined,
        bottom: type === "after" ? -1 : undefined,
        marginLeft: offset,
      }}
    >
      <div className="h-2 w-2 shrink-0 rounded-full border-2 border-sidebar-primary" />
      <div className="h-0.5 flex-1 bg-sidebar-primary" />
    </div>
  );
}
