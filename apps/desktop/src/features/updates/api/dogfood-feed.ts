import type { DogfoodFeed } from "../model";

export const DOGFOOD_FEED_URL =
  "https://raw.githubusercontent.com/venmakli/svode/update-feed/dogfood.json";

export async function fetchDogfoodFeed(
  signal?: AbortSignal,
): Promise<DogfoodFeed> {
  const response = await fetch(`${DOGFOOD_FEED_URL}?t=${Date.now()}`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Dogfood feed request failed: ${response.status}`);
  }

  const feed = (await response.json()) as DogfoodFeed;
  if (
    feed.schema !== 1 ||
    feed.channel !== "dogfood" ||
    !Array.isArray(feed.items)
  ) {
    throw new Error("Dogfood feed has an unsupported format");
  }

  return feed;
}
