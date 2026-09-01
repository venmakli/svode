import type { ReactNode } from "react";
import { CircleAlert, Inbox, SearchX, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import * as m from "@/paraglide/messages.js";

export function CollectionBlockingError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" data-collection-blocking-error>
      <TriangleAlert />
      <AlertTitle>{m.collection_blocking_error_title()}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function CollectionReadySignals({
  attention,
  diagnostics,
}: {
  attention?: ReactNode;
  diagnostics?: readonly ReactNode[];
}) {
  const hasAttention = attention !== undefined && attention !== null;

  return (
    <>
      {hasAttention ? (
        <Alert data-collection-attention>
          <CircleAlert />
          <AlertDescription>{attention}</AlertDescription>
        </Alert>
      ) : null}
      {diagnostics && diagnostics.length > 0 ? (
        <Alert data-collection-diagnostics>
          <TriangleAlert />
          <AlertDescription className="flex flex-col gap-1.5">
            {diagnostics.map((diagnostic, index) => (
              <div key={index}>{diagnostic}</div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export function CollectionSourceEmpty() {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{m.collection_source_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.collection_source_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CollectionQueryEmpty({ onClear }: { onClear(): void }) {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>{m.collection_query_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.collection_query_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          {m.collection_query_clear()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
