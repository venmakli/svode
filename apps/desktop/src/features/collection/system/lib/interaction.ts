import type {
  SystemCollectionDetailRequest,
  SystemCollectionPresentationDescriptor,
  SystemCollectionRenderer,
} from "../model/types";

const interactiveTargetSelector = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[data-system-collection-interactive]",
  "[data-radix-collection-item]",
].join(",");

export interface SystemCollectionCallbackResult {
  message?: string;
  ok: boolean;
}

export function createSystemCollectionPresentationScope(
  instanceKey: string,
  presentationId: string,
): string {
  return JSON.stringify([instanceKey, presentationId]);
}

export function isSystemCollectionInteractiveTarget(
  target: EventTarget | null,
  currentTarget: EventTarget,
): boolean {
  if (target === currentTarget || !target || typeof target !== "object") {
    return false;
  }

  const candidate = target as {
    closest?: (selector: string) => Element | null;
    parentElement?: Element | null;
  };
  const element =
    typeof candidate.closest === "function"
      ? candidate
      : candidate.parentElement &&
          typeof candidate.parentElement.closest === "function"
        ? candidate.parentElement
        : null;

  return Boolean(element?.closest?.(interactiveTargetSelector));
}

export async function runSystemCollectionCallback(
  callback: () => void | Promise<void>,
  fallbackMessage: string,
): Promise<SystemCollectionCallbackResult> {
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

export function createSystemCollectionDetailRequest<Row>({
  descriptor,
  instanceKey,
  row,
  rowId,
}: {
  descriptor: SystemCollectionPresentationDescriptor<Row>;
  instanceKey: string;
  row: Row;
  rowId: string;
}): SystemCollectionDetailRequest | null {
  if (!descriptor.createDetailRequest) {
    return null;
  }

  return {
    ...descriptor.createDetailRequest(row),
    selection: {
      instanceKey,
      presentationId: descriptor.id,
      rowId,
    },
  };
}

export function resolveSystemCollectionFocusIndex({
  currentIndex,
  itemCount,
  key,
  renderer,
  cardColumns = 1,
}: {
  currentIndex: number;
  itemCount: number;
  key: string;
  renderer: SystemCollectionRenderer;
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
    renderer === "list"
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
