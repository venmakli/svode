import { invokeCommand, convertFileSrc } from "@/platform/native/invoke";

export function resolveAssetAbsPath(
  url: string,
  projectPath: string,
  documentAbsPath: string,
): Promise<string> {
  return invokeCommand<string>("resolve_asset_url", {
    projectPath,
    documentAbsPath,
    assetPath: url,
  });
}

export function toWebviewAssetUrl(path: string): string {
  return convertFileSrc(path);
}
