import type { ReactNode } from "react";

import { CollectionPresentationToolbar } from "../../ui/presentation-chrome";

export function CollectionHostFrame({
  actions,
  children,
  tabs,
}: {
  actions?: ReactNode;
  children: ReactNode;
  tabs: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-collection-host>
      <CollectionPresentationToolbar tabs={tabs} actions={actions} />
      {children}
    </div>
  );
}
