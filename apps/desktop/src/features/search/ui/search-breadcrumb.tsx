import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type {
  KnowledgeNode,
  KnowledgeScope,
  KnowledgeSpaceOption,
} from "@/features/knowledge";
import * as m from "@/paraglide/messages.js";

interface SearchBreadcrumbModel {
  accessibleLabel: string;
  segments: Array<{ key: string; label: string | null }>;
}

export function SearchBreadcrumb({
  node,
  scope,
  spaces,
}: {
  node: KnowledgeNode | null;
  scope: KnowledgeScope;
  spaces: KnowledgeSpaceOption[];
}) {
  const model = buildSearchBreadcrumbModel(node, scope, spaces);

  return (
    <Breadcrumb
      aria-label={model.accessibleLabel}
      title={model.accessibleLabel}
      className="min-w-0"
      data-search-breadcrumb
    >
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
        {model.segments.map((segment, index) => (
          <Fragment key={segment.key}>
            {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
            <BreadcrumbItem className="min-w-0">
              {segment.label === null ? (
                <BreadcrumbEllipsis />
              ) : index === model.segments.length - 1 ? (
                <BreadcrumbPage className="truncate">
                  {segment.label}
                </BreadcrumbPage>
              ) : (
                <span className="max-w-40 truncate text-muted-foreground">
                  {segment.label}
                </span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function buildSearchBreadcrumbModel(
  node: KnowledgeNode | null,
  scope: KnowledgeScope,
  spaces: KnowledgeSpaceOption[],
): SearchBreadcrumbModel {
  if (!node) {
    const scopeLabel =
      scope.kind === "project"
        ? m.knowledge_graph_project_scope()
        : (spaces.find((space) => space.id === scope.spaceId)?.name ??
          m.knowledge_graph_root_space());
    return {
      accessibleLabel: `${scopeLabel} / ${m.knowledge_graph_title()}`,
      segments: [
        { key: "scope", label: scopeLabel },
        { key: "graph", label: m.knowledge_graph_title() },
      ],
    };
  }

  const sourcePath = node.canonicalSourcePath || node.source.path;
  const pathSegments = sourcePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  const artifactLabel = pathSegments.at(-1) || node.title || node.source.path;
  const accessiblePath =
    pathSegments.length > 0 ? pathSegments.join(" / ") : artifactLabel;
  const segments: SearchBreadcrumbModel["segments"] = [
    { key: "space", label: node.spaceName },
  ];
  if (pathSegments.length > 1) {
    segments.push({ key: "middle", label: null });
  }
  segments.push({ key: "artifact", label: artifactLabel });

  return {
    accessibleLabel: `${node.spaceName} / ${accessiblePath}`,
    segments,
  };
}
