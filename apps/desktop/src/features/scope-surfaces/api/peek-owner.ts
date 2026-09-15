import { getPageDetailState, readPage } from "@/features/page/page-api";
import { pathExists } from "@/platform/filesystem/path-api";
import {
  createAppDirectoryOwner,
  createCollectionDirectoryOwner,
  createPageOwner,
} from "../model/owners";
import type { ScopePeekContext } from "../model/peek";

export async function resolvePeekOwner(
  input: Pick<
    ScopePeekContext,
    "path" | "directory" | "spaceId" | "spacePath" | "projectPath"
  >,
) {
  const { path, directory, ...context } = input;
  const detail = directory
    ? null
    : await getPageDetailState({ spacePath: context.spacePath, path });
  if (detail?.form === "leaf") {
    return createPageOwner({
      ...context,
      status: "ready",
      form: "leaf",
      contentPath: path,
    });
  }
  const ownerPath = directory ? path : path.slice(0, path.lastIndexOf("/"));
  const [hasSchema, hasApp] = await Promise.all([
    pathExists(`${context.spacePath}/${ownerPath}/schema.yaml`),
    pathExists(`${context.spacePath}/${ownerPath}/app.yaml`),
  ]);
  const facts = { ...context, status: "ready" as const, ownerPath, hasApp };
  if (hasSchema) {
    const owner = createCollectionDirectoryOwner({ ...facts, hasSchema });
    if (!directory) owner.readmePath = path;
    return owner;
  }
  if (directory) {
    const [upper, lower] = await Promise.all([
      pathExists(`${context.spacePath}/${ownerPath}/README.md`),
      pathExists(`${context.spacePath}/${ownerPath}/readme.md`),
    ]);
    if (upper || lower) {
      const page = await readPage({
        spacePath: context.spacePath,
        path: `${ownerPath}/${upper ? "README.md" : "readme.md"}`,
      });
      return createPageOwner({
        ...facts,
        form: "folder",
        contentPath: page.path,
      });
    }
    return createAppDirectoryOwner(facts);
  }
  return createPageOwner({ ...facts, form: "folder", contentPath: path });
}
