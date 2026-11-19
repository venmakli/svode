import { useGitStore, type GitTransfer } from "../model";

/**
 * The shown transfer of the repository `spacePath` belongs to: its own or,
 * for a Space without one, the project's.
 */
export function useGitTransfer(spacePath: string): GitTransfer | undefined {
  return useGitStore((state) => {
    const repository = state.statuses[spacePath]?.repository ?? spacePath;
    return state.transfers[repository];
  });
}
