import {
  loadWorkingTreeItem,
  prepareTextDiff,
  type WorkingTreeItem,
} from "../api/inspection";
import type { InspectionScope } from "./scope";

const MAX_OPEN_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT = 2;

export function createItemReader() {
  let running = 0;
  let sequence = 0;
  const queue: (() => void)[] = [];
  const sizes = new Map<string, number>();
  const drain = () => {
    while (running < MAX_CONCURRENT && queue.length) queue.shift()!();
  };
  return {
    release(path: string) {
      sizes.delete(path);
    },
    read(
      scope: InspectionScope,
      path: string,
      active: () => boolean,
    ): Promise<WorkingTreeItem | undefined> {
      const generation = String(++sequence);
      return new Promise((resolve, reject) => {
        queue.push(() => {
          if (!active()) {
            resolve(undefined);
            return;
          }
          running++;
          void (async () => {
            const item = await loadWorkingTreeItem(
              scope.spacePath,
              path,
              generation,
              scope,
            );
            if (!active()) return;
            if (item.path !== path || item.generation !== generation)
              throw new Error("Stale inspection result");
            const bytes =
              new TextEncoder().encode(item.before ?? "").length +
              new TextEncoder().encode(item.after ?? "").length;
            const otherBytes = [...sizes].reduce(
              (sum, [key, value]) => sum + (key === path ? 0 : value),
              0,
            );
            if (otherBytes + bytes > MAX_OPEN_BYTES) {
              return {
                ...item,
                state: "truncated" as const,
                before: null,
                after: null,
                budgetLimited: true,
              };
            }
            sizes.set(path, bytes);
            return prepareTextDiff(item);
          })()
            .then(resolve, reject)
            .finally(() => {
              running--;
              drain();
            });
        });
        drain();
      });
    },
  };
}

export type ItemReader = ReturnType<typeof createItemReader>;
