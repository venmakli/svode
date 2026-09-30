import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { useSidebarGroupOpen } from "../hooks/use-sidebar-group-open";

interface NavigationSidebarGroupProps {
  /** Stable id of the group; its collapsed state is kept on this device. */
  id: string;
  label: string;
  /** Group action shown next to the label, e.g. its menu. */
  action?: ReactNode;
  children: ReactNode;
}

/** A sidebar section whose label collapses it. */
export function NavigationSidebarGroup({
  id,
  label,
  action,
  children,
}: NavigationSidebarGroupProps) {
  const [open, setOpen] = useSidebarGroupOpen(id);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/navigation-group"
    >
      <SidebarGroup className="py-1">
        <SidebarGroupLabel
          asChild
          className="gap-1 hover:text-sidebar-foreground"
        >
          <CollapsibleTrigger>
            <span className="truncate">{label}</span>
            <ChevronRight className="!size-3 opacity-0 transition group-hover/navigation-group:opacity-100 group-focus-within/navigation-group:opacity-100 group-data-[state=open]/navigation-group:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        {action}
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>{children}</SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}
