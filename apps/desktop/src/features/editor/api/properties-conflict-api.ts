import type { Page } from "@/features/page";
import {
  getPagePropertiesConflict,
  resolvePagePropertiesConflict,
} from "@/platform/git/git-api";

import { hasConflictMarkerCandidate } from "../conflict/conflict-markers";
import {
  readConflictBases,
  readConflictMarkerSize,
} from "./conflict-marker-api";
import type {
  PropertiesConflict,
  PropertiesResolution,
  PropertiesSide,
} from "../model/properties-conflict";

/**
 * The properties conflict of a loaded Page: Svode reads the places of its
 * frontmatter by the marker lines of `markerSize`. Only a Page whose
 * frontmatter does not read, and so came as the whole file, can have one.
 */
export async function readPropertiesConflict(
  page: Pick<Page, "body" | "warnings">,
  markerSize: number,
): Promise<PropertiesConflict | null> {
  if (
    !page.warnings?.some((warning) => warning.kind === "malformed_frontmatter")
  )
    return null;
  if (!hasConflictMarkerCandidate(page.body)) return null;
  const dto = await getPagePropertiesConflict({
    content: page.body,
    markerSize,
  });
  if (!dto) return null;
  return {
    source: page.body,
    markerSize,
    places:
      dto.places.type === "places"
        ? dto.places.places.map((place) => ({ ...place }))
        : [],
    unclear: dto.places.type === "unclear" ? dto.places.reason : null,
    body: dto.body,
    reachesText: dto.reachesText,
  };
}

/** The frontmatter `choices` give, checked as Svode reads frontmatter. */
export async function resolvePropertiesConflict(
  conflict: PropertiesConflict,
  choices: PropertiesSide[],
): Promise<PropertiesResolution> {
  const dto = await resolvePagePropertiesConflict({
    content: conflict.source,
    markerSize: conflict.markerSize,
    choices,
  });
  return dto.type === "resolved"
    ? { status: "resolved", frontmatter: dto.frontmatter }
    : { status: "unresolved", finding: dto.finding };
}

/**
 * The conflict marker size of the Page `page` read at `path`, the conflict
 * of its properties, if it has one, and the base of each conflict block of
 * the text the editor gets.
 */
export async function readPageConflicts(
  spacePath: string,
  path: string,
  page: Pick<Page, "body" | "warnings">,
): Promise<{
  markerSize: number;
  properties: PropertiesConflict | null;
  bases: (string | null)[];
}> {
  const markerSize = await readConflictMarkerSize(spacePath, path, page.body);
  const properties = await readPropertiesConflict(page, markerSize);
  const bases = await readConflictBases(
    spacePath,
    path,
    properties?.body ?? page.body,
    markerSize,
  );
  return { markerSize, properties, bases };
}
