import { invoke } from "@tauri-apps/api/core";
import type { Person } from "@/features/properties/model";

export function listCollectionPersons(spacePath: string, allTime = false) {
  return invoke<Person[]>("list_persons", {
    spacePath,
    allTime,
  });
}
