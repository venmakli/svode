import type { ReactNode } from "react";

import {
  defineSystemCollectionPresentation,
  type SystemCollectionActionState,
  type SystemCollectionDetailRequest,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionPresentationDescriptor,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import type { Column } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareActorsByDefault } from "../model/actor-values";
import type { ActorCatalogRow } from "../model/types";
import { ActorAvatar } from "./actor-avatar";
import { ActorDetail } from "./actor-detail";

export function createActorsPresentation({
  mutations,
  onRefresh = () => undefined,
  refreshing = false,
  spacePath,
  state,
}: {
  mutations?: ActorPresentationMutationActions;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  spacePath: string;
  state: SystemCollectionPresentationState<ActorCatalogRow>;
}) {
  return defineSystemCollectionPresentation({
    descriptor: createActorsPresentationDescriptor(spacePath, {
      mutations,
      onRefresh,
      refreshing,
    }),
    state,
  });
}

export function createActorsPresentationDescriptor(
  spacePath: string,
  {
    mutations,
    onRefresh = () => undefined,
    refreshing = false,
  }: {
    mutations?: ActorPresentationMutationActions;
    onRefresh?: () => void | Promise<void>;
    refreshing?: boolean;
  } = {},
): SystemCollectionPresentationDescriptor<ActorCatalogRow> {
  const disabledReason = m.actors_mutations_unavailable();
  const disabledState: SystemCollectionActionState = {
    reason: disabledReason,
    status: "disabled",
  };
  const contributionWithCommits = m.actors_contribution_commits();
  const contributionWithoutCommits = m.actors_contribution_no_commits();
  const fields: readonly SystemCollectionFieldDescriptor<ActorCatalogRow>[] = [
    propertyField(
      "contribution",
      m.actors_field_contribution(),
      {
        name: "contribution",
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
    ),
    propertyField(
      "commits",
      m.actors_field_commits(),
      { name: "commits", type: "number" },
      (row) => row.commitCount,
    ),
    propertyField(
      "activity",
      m.actors_field_activity(),
      { display: "medium", name: "activity", type: "date" },
      (row) => row.lastActivityDate,
    ),
  ];

  return {
    create: {
      getState: () => mutations?.createState ?? disabledState,
      id: "add-actor",
      label: m.actors_add(),
      run: () => mutations?.onAdd(),
    },
    createDetailRequest: (row) => createActorDetailRequest(row, spacePath),
    fields,
    getRowId: (row) => row.canonicalEmail,
    id: "humans",
    label: m.actors_presentation_humans(),
    layout: {
      density: "compact",
      getDescription: (row) => row.canonicalEmail,
      getTitle: (row) => row.displayName,
      kind: "list",
      renderLeading: (row) => <ActorAvatar actor={row} size="sm" />,
      visibleFields: ["commits", "activity"],
    },
    query: {
      defaultCompare: compareActorsByDefault,
      getSearchText: (row) => `${row.displayName} ${row.canonicalEmail}`,
    },
    refresh: {
      getState: () => (refreshing ? { status: "pending" } : { status: "idle" }),
      id: "refresh-actors",
      label: m.actors_refresh(),
      run: onRefresh,
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
  createState: SystemCollectionActionState;
  getMergeState(row: ActorCatalogRow): SystemCollectionActionState;
  getEditState(row: ActorCatalogRow): SystemCollectionActionState;
  onAdd(): void;
  onMerge(row: ActorCatalogRow): void;
  onEdit(row: ActorCatalogRow): void;
}

export function createActorDetailRequest(
  row: ActorCatalogRow,
  spacePath: string,
): Omit<SystemCollectionDetailRequest, "selection"> {
  return {
    content: <ActorDetail actor={row} spacePath={spacePath} />,
    description: row.canonicalEmail,
    title: (
      <span className="flex min-w-0 items-center gap-2.5">
        <ActorAvatar actor={row} size="sm" />
        <span className="truncate">{row.displayName}</span>
      </span>
    ),
  };
}

function propertyField(
  key: string,
  label: string,
  column: Column,
  getValue: (row: ActorCatalogRow) => unknown,
): SystemCollectionFieldDescriptor<ActorCatalogRow> {
  return {
    filter: { kind: "property" },
    getValue,
    key,
    label,
    sort: { kind: "property" },
    valueSemantics: { column, kind: "property" },
  };
}

export function actorCatalogBlockingError(
  title: string,
  detail: string,
): ReactNode {
  return (
    <span className="flex flex-col gap-1">
      <strong>{title}</strong>
      <span>{detail}</span>
    </span>
  );
}
