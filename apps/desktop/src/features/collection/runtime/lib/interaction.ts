import type { CollectionRenderer } from "../model/types";

export interface CollectionCallbackResult {
  message?: string;
  ok: boolean;
}

export function createCollectionPresentationScope(
  instanceKey: string,
  presentationId: string,
): string {
  return JSON.stringify([instanceKey, presentationId]);
}

export async function runCollectionCallback(
  callback: () => void | Promise<void>,
  fallbackMessage: string,
): Promise<CollectionCallbackResult> {
  try {
    await callback();
    return { ok: true };
  } catch (error) {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : fallbackMessage,
      ok: false,
    };
  }
}

export function resolveCollectionFocusIndex({
  currentIndex,
  itemCount,
  key,
  renderer,
  cardColumns = 1,
}: {
  currentIndex: number;
  itemCount: number;
  key: string;
  renderer: CollectionRenderer;
  cardColumns?: number;
}): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) {
    return null;
  }

  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }

  const offset =
    renderer === "list" || renderer === "table" || renderer === "calendar"
      ? key === "ArrowUp"
        ? -1
        : key === "ArrowDown"
          ? 1
          : 0
      : key === "ArrowLeft"
        ? -1
        : key === "ArrowRight"
          ? 1
          : key === "ArrowUp"
            ? -Math.max(1, cardColumns)
            : key === "ArrowDown"
              ? Math.max(1, cardColumns)
              : 0;

  if (offset === 0) {
    return null;
  }

  const nextIndex = currentIndex + offset;
  return nextIndex >= 0 && nextIndex < itemCount ? nextIndex : null;
}
