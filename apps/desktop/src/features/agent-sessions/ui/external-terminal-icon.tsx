import { createContext, useContext, type ReactNode } from "react";

import { ExternalAppIcon, type ExternalApp } from "@/features/external-open";

import { useExternalTerminalApp } from "../hooks";

const ExternalTerminalAppContext = createContext<ExternalApp | null>(null);

/** Shares the external terminal of one Sessions screen with its action icons. */
export function ExternalTerminalAppProvider({
  children,
}: {
  children: ReactNode;
}) {
  const app = useExternalTerminalApp();

  return (
    <ExternalTerminalAppContext.Provider value={app}>
      {children}
    </ExternalTerminalAppContext.Provider>
  );
}

export function ExternalTerminalIcon({
  "data-icon": dataIcon,
}: {
  "data-icon"?: "inline-start";
}) {
  const app = useContext(ExternalTerminalAppContext);
  return (
    <ExternalAppIcon
      app={app ?? { icon: null, kind: "terminal" }}
      data-icon={dataIcon}
    />
  );
}
