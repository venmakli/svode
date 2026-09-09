import { useMemo, useRef, useState } from "react";
import { AppSurface, type AppOwner } from "@/features/apps";
import { AppVariablesDialog } from "@/features/settings";

export function AppWithVariables({
  owner,
  name,
}: {
  owner: AppOwner;
  name?: string;
}) {
  return (
    <AppVariablesHost
      key={JSON.stringify([owner.projectPath, owner.spaceId, owner.ownerPath])}
      owner={owner}
      name={name}
    />
  );
}

function AppVariablesHost({ owner, name }: { owner: AppOwner; name?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const context = useMemo(
    () => ({
      projectPath: owner.projectPath,
      spaceId: owner.projectPath === owner.spacePath ? null : owner.spaceId,
      ownerPath: owner.ownerPath,
    }),
    [owner.projectPath, owner.spacePath, owner.spaceId, owner.ownerPath],
  );
  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col outline-none"
    >
      <AppSurface
        owner={owner}
        onOpenVariables={() => {
          triggerRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setOpen(true);
        }}
      />
      {open ? (
        <AppVariablesDialog
          context={context}
          name={name}
          onClose={() => setOpen(false)}
          returnFocus={() => {
            if (triggerRef.current?.isConnected) triggerRef.current.focus();
            else hostRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
