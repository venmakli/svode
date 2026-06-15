import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { Person } from "@/features/properties/model";

export function listCollectionPersons(spacePath: string, allTime = false) {
  return invoke<Person[]>("list_persons", {
    spacePath,
    allTime,
  });
}
