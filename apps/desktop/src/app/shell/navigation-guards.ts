import { prepareActiveContentDeactivation } from "@/features/artifact";

/**
 * The guards of the open peeks and the main area object, which every
 * navigation passes first; resolves whether they allow it.
 */
export async function passNavigationGuards(): Promise<boolean> {
  return (await prepareActiveContentDeactivation()) !== "blocked";
}
