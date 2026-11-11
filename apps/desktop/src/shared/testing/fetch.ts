type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

/**
 * A replacement for `fetch` in tests with the full `typeof fetch` shape: Bun's
 * `fetch` also carries `preconnect`, which a test replacement does not need.
 */
export function testFetch(implementation: FetchImplementation): typeof fetch {
  return Object.assign(implementation, { preconnect: () => {} });
}
