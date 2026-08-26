import { expect, test } from "bun:test";

import {
  MAX_VISIBLE_TIMEZONES,
  projectRoutineTimezoneOptions,
  timezoneDisplayLabel,
} from "./routine-time-basis";

const referenceDate = new Date("2026-08-26T00:00:00Z");

test("timezone option projection keeps local/current first and bounds fixed rendering", () => {
  const timezones = [
    "Asia/Novosibirsk",
    ...Array.from({ length: 140 }, (_, index) => `Etc/GMT${index}`),
  ];
  const projection = projectRoutineTimezoneOptions({
    currentTimezone: "Asia/Novosibirsk",
    localSearchText: "Local time",
    locale: "en",
    query: "",
    referenceDate,
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
    localSearchText: "Local time",
    locale: "en",
    query: "tokyo",
    referenceDate,
    timezones: ["Asia/Novosibirsk", "Asia/Tokyo", "Europe/Berlin"],
  });

  expect(projection).toEqual({
    fixedTimezones: ["Asia/Tokyo"],
    showCurrent: false,
    showLocal: false,
  });
});

test("timezone labels stay compact and localize city plus current GMT offset", () => {
  expect(
    timezoneDisplayLabel("Asia/Novosibirsk", "ru", referenceDate),
  ).toBe("Новосибирск — GMT+07:00");
  expect(timezoneDisplayLabel("Europe/London", "en", referenceDate)).toBe(
    "London — GMT+01:00",
  );
  expect(timezoneDisplayLabel("Mars/Olympus", "ru", referenceDate)).toBe(
    "Mars/Olympus",
  );
});

test("timezone search matches localized city, GMT offset, and canonical IANA id", () => {
  for (const query of ["новосибирск", "+07:00", "asia/novosibirsk"]) {
    const projection = projectRoutineTimezoneOptions({
      currentTimezone: null,
      localSearchText: "По местному времени",
      locale: "ru",
      query,
      referenceDate,
      timezones: ["Asia/Novosibirsk", "Europe/London"],
    });
    expect(projection.fixedTimezones).toEqual(["Asia/Novosibirsk"]);
  }
});
