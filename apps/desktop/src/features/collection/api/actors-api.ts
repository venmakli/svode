import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { ActorCandidate } from "@/features/properties";

export function listCollectionActors(spacePath: string, allTime = false) {
  return invoke<ActorCandidate[]>("list_actors", {
    spacePath,
    allTime,
  });
}
