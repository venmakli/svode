import type { ReactNode } from "react";

import {
  defineCollectionCorePresentation,
  type CollectionCoreActionState,
  type CollectionCoreActivationContext,
  type CollectionCorePresentationDescriptor,
  type CollectionCorePresentationState,
} from "@/features/collection/core";
import type { CollectionDetailContent } from "@/features/collection/app-shell";
import type {
  CollectionPropertyDefinition,
  CollectionPropertyOrigin,
  CollectionStandardPropertySemantics,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareActorsByDefault } from "../model/actor-values";
import type { ActorCatalogRow } from "../model/types";
import { ActorAvatar } from "./actor-avatar";
import { ActorDetail } from "./actor-detail";
import { CatalogRetryButton } from "./catalog-retry-button";

export function createActorsPresentation({
  mutations,
  onActivate,
  state,
}: {
  mutations?: ActorPresentationMutationActions;
  onActivate?(
    row: ActorCatalogRow,
    context: CollectionCoreActivationContext,
  ): void | Promise<void>;
  state: CollectionCorePresentationState<ActorCatalogRow>;
}) {
  return defineCollectionCorePresentation({
    descriptor: createActorsPresentationDescriptor({
      mutations,
      onActivate,
    }),
    state,
  });
}

export function createActorsPresentationDescriptor({
  mutations,
  onActivate,
}: {
  mutations?: ActorPresentationMutationActions;
  onActivate?: CollectionCorePresentationDescriptor<ActorCatalogRow>["onActivate"];
} = {}): CollectionCorePresentationDescriptor<ActorCatalogRow> {
  const disabledReason = m.actors_mutations_unavailable();
  const disabledState: CollectionCoreActionState = {
    reason: disabledReason,
    status: "disabled",
  };
  const contributionWithCommits = m.actors_contribution_commits();
  const contributionWithoutCommits = m.actors_contribution_no_commits();
  const properties: readonly CollectionPropertyDefinition<ActorCatalogRow>[] = [
    propertyField(
      "contribution",
      m.actors_field_contribution(),
      {
        options: [
          { color: "green", name: contributionWithCommits },
          { color: "neutral", name: contributionWithoutCommits },
        ],
        type: "select",
      },
      (row) =>
        row.contribution === "contributor"
          ? contributionWithCommits
          : contributionWithoutCommits,
      "owner_defined",
    ),
    propertyField(
      "commits",
      m.actors_field_commits(),
      { type: "number" },
      (row) => row.commitCount,
      "computed",
    ),
    propertyField(
      "activity",
      m.actors_field_activity(),
      { display: "medium", type: "date" },
      (row) => row.lastActivityDate,
      "computed",
    ),
  ];

  return {
    create: {
      getState: () => mutations?.createState ?? disabledState,
      id: "add-actor",
      label: m.actors_add(),
      run: () => mutations?.onAdd(),
    },
    onActivate,
    properties,
    getRowId: (row) => row.canonicalEmail,
    id: "humans",
    label: m.actors_presentation_humans(),
    layout: {
      density: "compact",
      getDescription: (row) => row.canonicalEmail,
      getTitle: (row) => row.displayName,
      kind: "list",
      renderLeading: (row) => <ActorAvatar actor={row} size="sm" />,
      visibleProperties: ["commits", "activity"],
    },
    query: {
      defaultCompare: compareActorsByDefault,
      getSearchText: (row) => `${row.displayName} ${row.canonicalEmail}`,
    },
    rowActions: [
      {
        getState: (row) => mutations?.getMergeState(row) ?? disabledState,
        id: "merge-actor",
        label: m.actors_merge(),
        run: (row) => mutations?.onMerge(row),
      },
      {
        getState: (row) => mutations?.getEditState(row) ?? disabledState,
        id: "edit-actor",
        label: m.actors_edit(),
        run: (row) => mutations?.onEdit(row),
      },
    ],
  };
}

interface ActorPresentationMutationActions {
  createState: CollectionCoreActionState;
  getMergeState(row: ActorCatalogRow): CollectionCoreActionState;
  getEditState(row: ActorCatalogRow): CollectionCoreActionState;
  onAdd(): void;
  onMerge(row: ActorCatalogRow): void;
  onEdit(row: ActorCatalogRow): void;
}

export function createActorDetailRequest(
  row: ActorCatalogRow,
  spacePath: string,
  catalogGeneration = 0,
): CollectionDetailContent {
  return {
    content: (
      <ActorDetail
        actor={row}
        catalogGeneration={catalogGeneration}
        spacePath={spacePath}
      />
    ),
    description: (
      <span className="sr-only">{m.actors_detail_description()}</span>
    ),
    title: (
      <span className="flex min-w-0 items-center gap-3">
        <ActorAvatar actor={row} size="lg" />
        <span className="flex min-w-0 flex-col text-left">
          <span className="truncate">{row.displayName}</span>
          <span className="truncate text-sm font-normal text-muted-foreground">
            {row.canonicalEmail}
          </span>
        </span>
      </span>
    ),
  };
}

function propertyField(
  key: string,
  label: string,
  standard: CollectionStandardPropertySemantics,
  getValue: (row: ActorCatalogRow) => unknown,
  origin: Exclude<
    CollectionPropertyOrigin,
    "schema_backed" | "domain_specific"
  >,
): CollectionPropertyDefinition<ActorCatalogRow> {
  return {
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    getValue,
    key,
    label,
    origin,
    owner: { featureId: "actors", kind: "feature" },
    semantics: { kind: "standard", standard },
  };
}

export function actorCatalogBlockingError(
  title: string,
  detail: string,
  retry?: {
    disabled: boolean;
    label: string;
    onRetry(): void;
  },
): ReactNode {
  return (
    <span className="flex flex-col items-start gap-2">
      <span className="flex flex-col gap-1">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {retry ? <CatalogRetryButton {...retry} /> : null}
    </span>
  );
}
