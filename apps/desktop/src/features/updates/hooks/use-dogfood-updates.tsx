import { createContext, useContext, type ReactNode } from "react";
import { useDogfoodUpdateCheck } from "./use-dogfood-update-check";

const DogfoodUpdatesContext = createContext<ReturnType<
  typeof useDogfoodUpdateCheck
> | null>(null);

export function DogfoodUpdatesProvider({
  version,
  buildCommit,
  children,
}: {
  version: string;
  buildCommit: string;
  children: ReactNode;
}) {
  const updates = useDogfoodUpdateCheck(version, buildCommit);
  return (
    <DogfoodUpdatesContext.Provider value={updates}>
      {children}
    </DogfoodUpdatesContext.Provider>
  );
}

export function useDogfoodUpdates() {
  const updates = useContext(DogfoodUpdatesContext);
  if (!updates) throw new Error("DogfoodUpdatesProvider is required");
  return updates;
}
