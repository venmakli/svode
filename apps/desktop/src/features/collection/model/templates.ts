import { normalizeEntryPath } from "../lib/utils";

export type TemplateKind = "leaf" | "folder" | "nestedCollection";
export type TemplateCommandKind = "leaf" | "folder" | "nested_collection";

export interface TemplateInfo {
  slug: string;
  kind: TemplateKind;
  title: string;
  icon?: string | null;
  isDefault?: boolean;
  is_default?: boolean;
}

type NormalizableTemplateInfo = Omit<TemplateInfo, "kind"> & {
  kind: string;
};

export function normalizeTemplateKind(kind: string): TemplateKind {
  if (kind === "nested_collection" || kind === "nestedCollection") {
    return "nestedCollection";
  }
  if (kind === "folder") return "folder";
  return "leaf";
}

export function templateKindToCommand(kind: TemplateKind): TemplateCommandKind {
  return kind === "nestedCollection" ? "nested_collection" : kind;
}

export function templateIsDefault(
  template: Pick<TemplateInfo, "isDefault" | "is_default">,
) {
  return Boolean(template.isDefault ?? template.is_default);
}

export function normalizeTemplateInfo(
  template: NormalizableTemplateInfo,
): TemplateInfo {
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
  const normalizedCollectionPath = normalizeEntryPath(collectionPath);
  const base = normalizedCollectionPath
    ? `${normalizedCollectionPath}/.templates/${template.slug}`
    : `.templates/${template.slug}`;
  return template.kind === "leaf" ? `${base}.md` : `${base}/README.md`;
}
