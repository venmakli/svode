export function getArtifactPresentationKind(facts: {
  hasSchema: boolean;
  hasApp: boolean;
  hasPage: boolean;
}): "collection" | "app" | "page" | "directory" {
  if (facts.hasSchema) return "collection";
  if (facts.hasApp) return "app";
  if (facts.hasPage) return "page";
  return "directory";
}
