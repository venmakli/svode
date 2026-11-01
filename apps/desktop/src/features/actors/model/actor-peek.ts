/** The item the peek of the Actors shows: a person or an Agent Actor. */
export interface ActorPeekTarget {
  presentationId: "humans" | "agents";
  /** The item id of its presentation. */
  itemId: string;
}

export function actorPeekIdentity(target: ActorPeekTarget): string {
  return `${target.presentationId}:${target.itemId}`;
}
