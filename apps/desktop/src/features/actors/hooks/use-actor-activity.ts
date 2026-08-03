import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadActorActivity } from "../api/actors-api";
import {
  defaultActorActivityYear,
  mergeActorActivityPage,
} from "../model/actor-values";
import type { ActorActivitySnapshot } from "../model/types";

export type ActorActivityResource =
  | { phase: "initial" }
  | { phase: "loading" }
  | { error: string; phase: "error" }
  | {
      loadMoreError: string | null;
      loadingMore: boolean;
      phase: "ready";
      snapshot: ActorActivitySnapshot;
    };

interface StoredResource {
  requestId: number;
  resource: ActorActivityResource;
}

const INITIAL_RESOURCE: ActorActivityResource = { phase: "initial" };

export function useActorActivity({
  availableYears,
  canonicalEmail,
  spacePath,
}: {
  availableYears: readonly number[];
  canonicalEmail: string;
  spacePath: string;
}) {
  const [selectedYear, setSelectedYear] = useState(() =>
    defaultActorActivityYear(availableYears),
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [resources, setResources] = useState<Record<string, StoredResource>>(
    {},
  );
  const requestSequence = useRef(0);
  const generation = useRef<number | null>(null);

  const loadInitial = useCallback(
    (year: number, day: string | null) => {
      const key = activityResourceKey(year, day);
      const requestId = ++requestSequence.current;
      setResources((current) => ({
        ...current,
        [key]: { requestId, resource: { phase: "loading" } },
      }));

      void loadActorActivity(spacePath, canonicalEmail, {
        selectedDay: day,
        selectedYear: year,
      }).then(
        (snapshot) => {
          setResources((current) => {
            if (current[key]?.requestId !== requestId) return current;
            const resource: StoredResource = {
              requestId,
              resource: {
                loadMoreError: null,
                loadingMore: false,
                phase: "ready",
                snapshot,
              },
            };
            if (
              generation.current !== null &&
              snapshot.generation < generation.current
            ) {
              return {
                ...current,
                [key]: {
                  requestId,
                  resource: {
                    error:
                      "Actor activity response belongs to a stale repository generation",
                    phase: "error",
                  },
                },
              };
            }
            if (
              generation.current !== null &&
              snapshot.generation > generation.current
            ) {
              generation.current = snapshot.generation;
              return { [key]: resource };
            }
            generation.current = snapshot.generation;
            return { ...current, [key]: resource };
          });
        },
        (error: unknown) => {
          setResources((current) =>
            current[key]?.requestId === requestId
              ? {
                  ...current,
                  [key]: {
                    requestId,
                    resource: {
                      error: actorActivityErrorMessage(error),
                      phase: "error",
                    },
                  },
                }
              : current,
          );
        },
      );
    },
    [canonicalEmail, spacePath],
  );

  const yearKey = activityResourceKey(selectedYear, null);
  const dayKey = selectedDay
    ? activityResourceKey(selectedYear, selectedDay)
    : null;
  const yearResource = resources[yearKey]?.resource ?? INITIAL_RESOURCE;
  const timelineResource = dayKey
    ? (resources[dayKey]?.resource ?? INITIAL_RESOURCE)
    : yearResource;

  useEffect(() => {
    if (!resources[yearKey]) loadInitial(selectedYear, null);
  }, [loadInitial, resources, selectedYear, yearKey]);

  useEffect(() => {
    if (dayKey && !resources[dayKey]) loadInitial(selectedYear, selectedDay);
  }, [dayKey, loadInitial, resources, selectedDay, selectedYear]);

  const selectYear = useCallback((year: number) => {
    setSelectedDay(null);
    setSelectedYear(year);
  }, []);

  const selectDay = useCallback((day: string) => setSelectedDay(day), []);
  const resetDay = useCallback(() => setSelectedDay(null), []);

  const retryYear = useCallback(() => {
    setResources((current) => withoutResource(current, yearKey));
  }, [yearKey]);

  const retryTimeline = useCallback(() => {
    const key = dayKey ?? yearKey;
    setResources((current) => withoutResource(current, key));
  }, [dayKey, yearKey]);

  const loadMore = useCallback(() => {
    const key = dayKey ?? yearKey;
    const stored = resources[key];
    if (
      !stored ||
      stored.resource.phase !== "ready" ||
      stored.resource.loadingMore ||
      !stored.resource.snapshot.timeline.nextCursor
    ) {
      return;
    }

    const base = stored.resource.snapshot;
    const cursor = base.timeline.nextCursor;
    const requestId = ++requestSequence.current;
    setResources((current) => {
      const latest = current[key];
      if (!latest || latest.resource.phase !== "ready") return current;
      return {
        ...current,
        [key]: {
          requestId,
          resource: {
            ...latest.resource,
            loadMoreError: null,
            loadingMore: true,
          },
        },
      };
    });

    void loadActorActivity(spacePath, canonicalEmail, {
      cursor,
      selectedDay,
      selectedYear,
    }).then(
      (page) => {
        setResources((current) => {
          const latest = current[key];
          if (
            latest?.requestId !== requestId ||
            latest.resource.phase !== "ready"
          ) {
            return current;
          }
          try {
            return {
              ...current,
              [key]: {
                requestId,
                resource: {
                  loadMoreError: null,
                  loadingMore: false,
                  phase: "ready",
                  snapshot: mergeActorActivityPage(base, page),
                },
              },
            };
          } catch (error) {
            return {
              ...current,
              [key]: {
                requestId,
                resource: {
                  ...latest.resource,
                  loadMoreError: actorActivityErrorMessage(error),
                  loadingMore: false,
                },
              },
            };
          }
        });
      },
      (error: unknown) => {
        setResources((current) => {
          const latest = current[key];
          if (
            latest?.requestId !== requestId ||
            latest.resource.phase !== "ready"
          ) {
            return current;
          }
          return {
            ...current,
            [key]: {
              requestId,
              resource: {
                ...latest.resource,
                loadMoreError: actorActivityErrorMessage(error),
                loadingMore: false,
              },
            },
          };
        });
      },
    );
  }, [
    canonicalEmail,
    dayKey,
    resources,
    selectedDay,
    selectedYear,
    spacePath,
    yearKey,
  ]);

  return useMemo(
    () => ({
      loadMore,
      resetDay,
      retryTimeline,
      retryYear,
      selectDay,
      selectedDay,
      selectedYear,
      selectYear,
      timelineResource,
      yearResource,
    }),
    [
      loadMore,
      resetDay,
      retryTimeline,
      retryYear,
      selectDay,
      selectedDay,
      selectedYear,
      selectYear,
      timelineResource,
      yearResource,
    ],
  );
}

function activityResourceKey(year: number, day: string | null) {
  return day ? `day:${year}:${day}` : `year:${year}`;
}

function withoutResource(
  resources: Record<string, StoredResource>,
  key: string,
) {
  const next = { ...resources };
  delete next[key];
  return next;
}

function actorActivityErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown actor activity error";
}
