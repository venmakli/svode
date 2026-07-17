import {
  openEntryDocument,
  openEntryScopeHome,
} from "@/features/entry/selection";

export function openScopeHomeSelection(spaceId: string) {
  openEntryScopeHome(spaceId);
}

export function openSpaceReadmeDocument(spaceId: string) {
  openEntryDocument("README.md", spaceId);
}
