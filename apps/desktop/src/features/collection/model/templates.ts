export type TemplateKind = "leaf" | "folder" | "nestedCollection";

export interface TemplateInfo {
  slug: string;
  kind: TemplateKind;
  title: string;
  icon?: string | null;
  isDefault?: boolean;
  is_default?: boolean;
}

export function normalizeTemplateKind(kind: string): TemplateKind {
  if (kind === "nested_collection" || kind === "nestedCollection") {
    return "nestedCollection";
  }
  if (kind === "folder") return "folder";
  return "leaf";
}

export function templateKindToCommand(kind: TemplateKind) {
  return kind === "nestedCollection" ? "nested_collection" : kind;
}

export function templateIsDefault(template: TemplateInfo) {
  return Boolean(template.isDefault ?? template.is_default);
}

export function normalizeTemplateInfo(template: TemplateInfo): TemplateInfo {
  return {
    ...template,
    kind: normalizeTemplateKind(template.kind),
    isDefault: templateIsDefault(template),
  };
}

export function templateHeadPath(
  collectionPath: string,
  template: Pick<TemplateInfo, "slug" | "kind">,
) {
  const base = collectionPath
    ? `${collectionPath}/.templates/${template.slug}`
    : `.templates/${template.slug}`;
  return template.kind === "leaf" ? `${base}.md` : `${base}/README.md`;
}
