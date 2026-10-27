import { Box, FolderClosed } from "lucide-react";
import type { ScopeMark } from "../../lib";

/** The emoji of a Space or project, otherwise the icon of its kind. */
export function ScopeIcon({
  mark,
}: {
  mark: Pick<ScopeMark, "icon" | "kind">;
}) {
  if (mark.icon) {
    return (
      <span className="flex size-4 items-center justify-center text-sm leading-none">
        {mark.icon}
      </span>
    );
  }
  return mark.kind === "project" ? <Box /> : <FolderClosed />;
}

/** The icon and name the draft's Space button and the session's label share. */
export function ScopeMarkContent({ mark }: { mark: ScopeMark }) {
  return (
    <>
      <ScopeIcon mark={mark} />
      <span className="truncate">{mark.name}</span>
    </>
  );
}

/**
 * The Space of a session under its composer: the draft's Space button
 * without the choice, so its icon and name keep their place after the
 * first send (Stage 10 `04`, composer).
 */
export function ScopeLabel({ mark }: { mark: ScopeMark }) {
  return (
    <span className="-ms-1.5 flex h-6 max-w-64 min-w-0 items-center gap-1 border border-transparent px-2 font-medium [&_svg]:size-3 [&_svg]:shrink-0">
      <ScopeMarkContent mark={mark} />
    </span>
  );
}
