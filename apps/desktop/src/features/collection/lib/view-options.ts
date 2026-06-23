import type { CollectionView } from "@/features/collection/query/model";

export function showNestedForView(view: CollectionView) {
  const raw = view.show_nested ?? view.showNested;
  return raw === undefined ? true : Boolean(raw);
}
