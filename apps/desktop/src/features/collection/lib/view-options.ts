import type { CollectionView } from "@/features/collection/query";

export function showNestedForView(view: CollectionView) {
  const raw = view.show_nested ?? view.showNested;
  return raw === undefined ? true : Boolean(raw);
}
