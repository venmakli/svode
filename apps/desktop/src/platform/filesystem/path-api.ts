import { invokeCommand } from "@/platform/native/invoke";

export function pathExists(path: string): Promise<boolean> {
  return invokeCommand<boolean>("path_exists", { path });
}
