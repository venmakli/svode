import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function IncompleteState({
  title,
  action,
}: {
  title: string;
  action: string;
}) {
  return (
    <div className="flex p-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Settings />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" size="sm">
            {action}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
