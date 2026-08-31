import { FilePlus } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useRootContentActions } from "../hooks/use-root-content-actions";

/**
 * Shown when a project has no Pages and no children.
 */
export function EmptyProjectState() {
  const { activeRootPath, handleNewPage } = useRootContentActions();

  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilePlus />
        </EmptyMedia>
        <EmptyTitle>{m.project_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.project_empty_description()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={handleNewPage} disabled={!activeRootPath}>
          <FilePlus data-icon="inline-start" />
          {m.project_empty_create_page()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
