import { createContext, useContext, type ReactNode } from "react";

import type { OpenWithGroup } from "../model/types";

type RenderGroup = (group: OpenWithGroup) => ReactNode;

const ExternalOpenGroupHostContext = createContext<RenderGroup | null>(null);

/**
 * Hands the group of an `ExternalOpenButton` inside to `render` instead of
 * drawing the button, so a host shows it among its own groups, as the main
 * top bar shows the object group before the project applications.
 */
export function ExternalOpenGroupHost({
  render,
  children,
}: {
  render: RenderGroup;
  children: ReactNode;
}) {
  return (
    <ExternalOpenGroupHostContext.Provider value={render}>
      {children}
    </ExternalOpenGroupHostContext.Provider>
  );
}

export function useExternalOpenGroupHost(): RenderGroup | null {
  return useContext(ExternalOpenGroupHostContext);
}
