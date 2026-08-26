import { expect, test } from "bun:test";

import {
  MAX_VISIBLE_TIMEZONES,
  projectRoutineTimezoneOptions,
} from "./routine-time-basis";

test("timezone option projection keeps local/current first and bounds fixed rendering", () => {
  const timezones = [
    "Asia/Novosibirsk",
    ...Array.from({ length: 140 }, (_, index) => `Etc/GMT${index}`),
  ];
  const projection = projectRoutineTimezoneOptions({
    currentTimezone: "Asia/Novosibirsk",
    localSearchText: "Local time follows the current system timezone",
    query: "",
    timezones,
  });

  expect(projection.showLocal).toBe(true);
  expect(projection.showCurrent).toBe(true);
  expect(projection.fixedTimezones.length).toBe(MAX_VISIBLE_TIMEZONES);
  expect(projection.fixedTimezones.includes("Asia/Novosibirsk")).toBe(false);
});

test("timezone option projection searches city and canonical IANA id", () => {
  const projection = projectRoutineTimezoneOptions({
    currentTimezone: "Asia/Novosibirsk",
    localSearchText: "Local time follows the current system timezone",
    query: "tokyo",
    timezones: ["Asia/Novosibirsk", "Asia/Tokyo", "Europe/Berlin"],
  });

  expect(projection).toEqual({
    fixedTimezones: ["Asia/Tokyo"],
    showCurrent: false,
    showLocal: false,
  });
});
