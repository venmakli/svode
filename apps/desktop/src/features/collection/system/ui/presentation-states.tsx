import type { ReactNode } from "react";
import {
  CircleAlert,
  Inbox,
  LoaderCircle,
  SearchX,
  TriangleAlert,
} from "lucide-react";

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

export function SystemCollectionBlockingError({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <Alert variant="destructive" data-system-collection-blocking-error>
      <TriangleAlert />
      <AlertTitle>{m.system_collection_blocking_error_title()}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function SystemCollectionReadySignals({
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
        <Alert data-system-collection-attention>
          <CircleAlert />
          <AlertDescription>{attention}</AlertDescription>
        </Alert>
      ) : null}
      {diagnostics && diagnostics.length > 0 ? (
        <Alert data-system-collection-diagnostics>
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

export function SystemCollectionRefreshingStatus() {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground"
      data-system-collection-refreshing
    >
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      {m.system_collection_refreshing()}
    </span>
  );
}

export function SystemCollectionSourceEmpty() {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{m.system_collection_source_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.system_collection_source_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function SystemCollectionQueryEmpty({ onClear }: { onClear(): void }) {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>{m.system_collection_query_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.system_collection_query_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          {m.system_collection_query_clear()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
