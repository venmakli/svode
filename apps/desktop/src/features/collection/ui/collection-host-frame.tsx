import type { ReactNode } from "react";

import { CollectionPresentationToolbar } from "./presentation-chrome";

export function CollectionHostFrame({
  actions,
  children,
  definition,
  tabs,
}: {
  actions?: ReactNode;
  children: ReactNode;
  definition: "fixed" | "schema-backed";
  tabs: ReactNode;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-collection-definition={definition}
      data-collection-host
    >
      <CollectionPresentationToolbar tabs={tabs} actions={actions} />
      {children}
    </div>
  );
}
