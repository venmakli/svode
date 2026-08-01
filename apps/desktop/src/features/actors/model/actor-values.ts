import type {
  ActorActivitySnapshot,
  ActorAlias,
  ActorCatalogRow,
} from "./types";

const DAY_MS = 86_400_000;

export interface ActorHeatmapCell {
  commitCount: number;
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
}

export function compareActorsByDefault(
  left: ActorCatalogRow,
  right: ActorCatalogRow,
) {
  if (left.lastCommitAt === null && right.lastCommitAt !== null) return 1;
  if (left.lastCommitAt !== null && right.lastCommitAt === null) return -1;
  if (
    left.lastCommitAt !== null &&
    right.lastCommitAt !== null &&
    left.lastCommitAt !== right.lastCommitAt
  ) {
    return right.lastCommitAt - left.lastCommitAt;
  }

  const nameComparison = normalizeActorText(left.displayName).localeCompare(
    normalizeActorText(right.displayName),
  );
  return (
    nameComparison ||
    normalizeActorText(left.canonicalEmail).localeCompare(
      normalizeActorText(right.canonicalEmail),
    )
  );
}

export function actorInitials(actor: ActorCatalogRow) {
  const initials = actor.displayName
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
    .join("");
  return initials || actor.canonicalEmail.slice(0, 2).toUpperCase();
}

export function visibleActorAliases(actor: ActorCatalogRow): ActorAlias[] {
  const seen = new Set<string>();
  return actor.aliases.filter((alias) => {
    const normalizedName = normalizeActorText(alias.name ?? "");
    const normalizedEmail = normalizeActorText(alias.email);
    if (
      normalizedEmail === normalizeActorText(actor.canonicalEmail) &&
      (!normalizedName ||
        normalizedName === normalizeActorText(actor.displayName))
    ) {
      return false;
    }
    const key = `${normalizedName}\0${normalizedEmail}\0${alias.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildActorHeatmapCells(
  activity: ActorActivitySnapshot,
): readonly (ActorHeatmapCell | null)[] {
  const start = parseCalendarDate(activity.rangeStart);
  const endExclusive = parseCalendarDate(activity.rangeEndExclusive);
  if (!start || !endExclusive || endExclusive <= start) return [];

  const counts = new Map(
    activity.days.map((day) => [day.date, day.commitCount] as const),
  );
  const maximum = Math.max(0, ...counts.values());
  const result: (ActorHeatmapCell | null)[] = Array.from(
    { length: start.getUTCDay() },
    () => null,
  );

  for (
    let cursor = start.getTime();
    cursor < endExclusive.getTime();
    cursor += DAY_MS
  ) {
    const date = formatCalendarDate(new Date(cursor));
    const commitCount = counts.get(date) ?? 0;
    result.push({
      commitCount,
      date,
      level: activityLevel(commitCount, maximum),
    });
  }

  while (result.length % 7 !== 0) result.push(null);
  return result;
}

export function actorActivityEndDate(activity: ActorActivitySnapshot) {
  const endExclusive = parseCalendarDate(activity.rangeEndExclusive);
  return endExclusive
    ? formatCalendarDate(new Date(endExclusive.getTime() - DAY_MS))
    : activity.rangeEndExclusive;
}

function activityLevel(
  commitCount: number,
  maximum: number,
): 0 | 1 | 2 | 3 | 4 {
  if (commitCount <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((commitCount / maximum) * 4))) as
    | 1
    | 2
    | 3
    | 4;
}

function normalizeActorText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function parseCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return formatCalendarDate(date) === value ? date : null;
}

function formatCalendarDate(date: Date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
