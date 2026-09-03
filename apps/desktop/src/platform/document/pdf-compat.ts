type AsyncReadableStream<T> = ReadableStream<T> & AsyncIterable<T>;

export function ensureReadableStreamAsyncIterator() {
  const prototype = ReadableStream.prototype as AsyncReadableStream<unknown>;
  if (Symbol.asyncIterator in prototype) return;

  Object.defineProperty(prototype, Symbol.asyncIterator, {
    configurable: true,
    value: async function* <T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
    writable: true,
  });
}
