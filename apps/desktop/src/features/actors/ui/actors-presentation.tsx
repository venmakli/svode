import type { ReactNode } from "react";

import {
  defineSystemCollectionPresentation,
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
  onRefresh = () => undefined,
  refreshing = false,
  spacePath,
  state,
}: {
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  spacePath: string;
  state: SystemCollectionPresentationState<ActorCatalogRow>;
}) {
  return defineSystemCollectionPresentation({
    descriptor: createActorsPresentationDescriptor(spacePath, {
      onRefresh,
      refreshing,
    }),
    state,
  });
}

export function createActorsPresentationDescriptor(
  spacePath: string,
  {
    onRefresh = () => undefined,
    refreshing = false,
  }: {
    onRefresh?: () => void | Promise<void>;
    refreshing?: boolean;
  } = {},
): SystemCollectionPresentationDescriptor<ActorCatalogRow> {
  const disabledReason = m.actors_mutations_unavailable();
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
      getState: () => ({ status: "disabled", reason: disabledReason }),
      id: "add-actor",
      label: m.actors_add(),
      run: () => undefined,
    },
    createDetailRequest: (row) => ({
      content: <ActorDetail actor={row} spacePath={spacePath} />,
      description: row.canonicalEmail,
      title: (
        <span className="flex min-w-0 items-center gap-2.5">
          <ActorAvatar actor={row} size="sm" />
          <span className="truncate">{row.displayName}</span>
        </span>
      ),
    }),
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
        getState: () => ({ status: "disabled", reason: disabledReason }),
        id: "merge-actor",
        label: m.actors_merge(),
        run: () => undefined,
      },
      {
        getState: () => ({ status: "disabled", reason: disabledReason }),
        id: "edit-actor",
        label: m.actors_edit(),
        run: () => undefined,
      },
    ],
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
