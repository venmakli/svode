import { Waypoints } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import * as m from "@/paraglide/messages.js";

/** The Graph in the breadcrumb position of the main top bar. */
export function KnowledgeGraphBreadcrumb() {
  return (
    <Breadcrumb className="min-w-0 px-2">
      <BreadcrumbList className="min-w-0 flex-nowrap text-sm">
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
            <Waypoints aria-hidden className="size-4 shrink-0" />
            <span className="truncate">{m.knowledge_graph_title()}</span>
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
