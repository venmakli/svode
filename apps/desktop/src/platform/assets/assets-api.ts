import { invokeCommand, convertFileSrc } from "@/platform/native/invoke";
import { logTiming, nowMs } from "@/shared/lib/performance";

export async function resolveAssetAbsPath(
  url: string,
  projectPath: string,
  documentAbsPath: string,
): Promise<string> {
  const startedAt = nowMs();
  let status: "ok" | "error" = "ok";
  try {
    return await invokeCommand<string>("resolve_asset_url", {
      projectPath,
      documentAbsPath,
      assetPath: url,
    });
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    logTiming("asset.resolve", startedAt, { status });
  }
}

export function toWebviewAssetUrl(path: string): string {
  return convertFileSrc(path);
}
