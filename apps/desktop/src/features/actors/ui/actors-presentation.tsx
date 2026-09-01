import type { ReactNode } from "react";

import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionActivationContext,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import type { CollectionDetailContent } from "@/features/collection/app-shell";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  type CollectionPropertyDefinition,
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
    context: CollectionActivationContext,
  ): void | Promise<void>;
  state: CollectionPresentationState<ActorCatalogRow>;
}) {
  return defineCollectionPresentation({
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
  onActivate?: CollectionPresentationDescriptor<ActorCatalogRow>["onActivate"];
} = {}): CollectionPresentationDescriptor<ActorCatalogRow> {
  const disabledReason = m.actors_mutations_unavailable();
  const disabledState: CollectionActionState = {
    reason: disabledReason,
    status: "disabled",
  };
  const contributionWithCommits = m.actors_contribution_commits();
  const contributionWithoutCommits = m.actors_contribution_no_commits();
  const properties: readonly CollectionPropertyDefinition<ActorCatalogRow>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) =>
        row.contribution === "contributor"
          ? contributionWithCommits
          : contributionWithoutCommits,
      key: "contribution",
      label: m.actors_field_contribution(),
      standard: {
        options: [
          { color: "green", name: contributionWithCommits },
          { color: "neutral", name: contributionWithoutCommits },
        ],
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) => row.commitCount,
      key: "commits",
      label: m.actors_field_commits(),
      standard: { type: "number" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) => row.lastActivityDate,
      key: "activity",
      label: m.actors_field_activity(),
      standard: { display: "medium", type: "date" },
    }),
  ];

  return {
    create: {
      label: m.actors_add(),
      intents: [
        {
          getState: () => mutations?.createState ?? disabledState,
          id: "add-actor",
          label: m.actors_add(),
          run: () => mutations?.onAdd(),
        },
      ],
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
  createState: CollectionActionState;
  getMergeState(row: ActorCatalogRow): CollectionActionState;
  getEditState(row: ActorCatalogRow): CollectionActionState;
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
