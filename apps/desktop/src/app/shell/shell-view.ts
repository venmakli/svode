import { createContext, useContext } from "react";

/** What the shell shows: the Space of the active project, or Home. */
export type ShellView = "space" | "home";

export const ShellViewContext = createContext<ShellView>("space");

export function useShellView(): ShellView {
  return useContext(ShellViewContext);
}
