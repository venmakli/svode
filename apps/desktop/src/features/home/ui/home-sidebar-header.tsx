import * as m from "@/paraglide/messages.js";

/** The Home sidebar header in place of the project switcher. */
export function HomeSidebarHeader() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
      <img src="/logo.png" alt="" className="size-5 shrink-0" />
      <span className="truncate text-sm font-medium">{m.home_title()}</span>
    </div>
  );
}
