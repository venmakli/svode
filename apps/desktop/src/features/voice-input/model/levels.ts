/** How many 50 ms windows the wave shows: the last two seconds. */
export const WAVE_BARS = 40;

/**
 * The recent levels of a recording, outside React state: they arrive 20
 * times a second, and only the wave redraws for them.
 */
export class LevelHistory {
  private levels: number[] = [];
  private readonly listeners = new Set<() => void>();

  push(dbfs: number) {
    this.levels = [...this.levels.slice(-(WAVE_BARS - 1)), dbfs];
    for (const listener of this.listeners) listener();
  }

  clear() {
    this.levels = [];
    for (const listener of this.listeners) listener();
  }

  snapshot = (): readonly number[] => this.levels;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
