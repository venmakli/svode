export type CollectionGalleryCardDensity = "compact" | "comfortable";
export type CollectionGalleryCardSize = "small" | "medium" | "large";

export const COLLECTION_GALLERY_CARD_WIDTH: Record<
  CollectionGalleryCardSize,
  number
> = {
  small: 160,
  medium: 240,
  large: 320,
};

export function collectionGalleryCardWidth(
  size: CollectionGalleryCardSize,
): number {
  return COLLECTION_GALLERY_CARD_WIDTH[size];
}
