import { expect, test } from "bun:test";

import {
  groupRoutineTimezones,
  matchesRoutineTimezone,
  timezoneDisplayLabel,
} from "./routine-time-basis";

const referenceDate = new Date("2026-08-26T00:00:00Z");

test("timezone groups exclude the current suggestion and put its region first", () => {
  const groups = groupRoutineTimezones({
    currentTimezone: "Asia/Novosibirsk",
    timezones: [
      "America/New_York",
      "Asia/Novosibirsk",
      "Asia/Tokyo",
      "Europe/Berlin",
      "Pacific/Auckland",
      "UTC",
    ],
  });

  expect(groups.map((group) => group.region)).toEqual([
    "asia",
    "americas",
    "europe",
    "oceania",
    "other",
  ]);
  expect(groups[0]?.timezones).toEqual(["Asia/Tokyo"]);
  expect(
    groups.some((group) => group.timezones.includes("Asia/Novosibirsk")),
  ).toBe(false);
});

test("timezone labels stay compact and localize city plus current GMT offset", () => {
  expect(timezoneDisplayLabel("Asia/Novosibirsk", "ru", referenceDate)).toBe(
    "Новосибирск — GMT+07:00",
  );
  expect(timezoneDisplayLabel("Europe/London", "en", referenceDate)).toBe(
    "London — GMT+01:00",
  );
  expect(timezoneDisplayLabel("Mars/Olympus", "ru", referenceDate)).toBe(
    "Mars/Olympus",
  );
});

test("timezone search matches localized city, GMT offset, and canonical IANA id", () => {
  for (const query of ["новосибирск", "+07:00", "asia/novosibirsk"]) {
    expect(
      matchesRoutineTimezone("Asia/Novosibirsk", query, "ru", referenceDate),
    ).toBe(true);
  }
  expect(
    matchesRoutineTimezone("Europe/London", "новосибирск", "ru", referenceDate),
  ).toBe(false);
});
