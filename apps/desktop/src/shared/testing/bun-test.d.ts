declare module "bun:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;

  export function expect<T>(actual: T): {
    toBe(expected: T): void;
    toBeNull(): void;
    toEqual(expected: unknown): void;
  };
}
