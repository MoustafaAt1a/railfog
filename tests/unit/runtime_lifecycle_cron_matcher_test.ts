// spec: contracts/functions.contract.md#FN-2 — schedule triggers declare a
// standard 5-field cron expression; the runtime fires them on that schedule.

import { assert, assertThrows } from "@std/assert";
import { compileCron } from "../../runtime/lifecycle/cron-matcher.ts";

function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  // Cron fields are matched against local-time components, so the test
  // constructs dates through the local-time constructor to stay
  // timezone-independent.
  return new Date(year, month - 1, day, hour, minute, second);
}

Deno.test("FN-2: cron matcher fires */5 on multiples of five minutes only", () => {
  const cron = compileCron("*/5 * * * *");
  const local = (d: Date) => d; // minutes/hours are field-matched per timezone-independent components

  assert(cron.matches(local(utcDate(2026, 9, 22, 10, 0))));
  assert(cron.matches(local(utcDate(2026, 9, 22, 10, 5))));
  assert(cron.matches(local(utcDate(2026, 9, 22, 23, 55))));
  assert(!cron.matches(local(utcDate(2026, 9, 22, 10, 3))));
  assert(!cron.matches(local(utcDate(2026, 9, 22, 10, 7))));
});

Deno.test("FN-2: cron matcher supports exact fields, lists, and ranges", () => {
  const dailyNoon = compileCron("0 12 * * *");
  assert(dailyNoon.matches(utcDate(2026, 1, 1, 12, 0)));
  assert(!dailyNoon.matches(utcDate(2026, 1, 1, 12, 1)));
  assert(!dailyNoon.matches(utcDate(2026, 1, 1, 13, 0)));

  const weekdayList = compileCron("30 9 * * 1,3,5");
  // 2026-09-21 is a Monday, 2026-09-22 is a Tuesday
  assert(weekdayList.matches(utcDate(2026, 9, 21, 9, 30)));
  assert(!weekdayList.matches(utcDate(2026, 9, 22, 9, 30)));

  const rangeStep = compileCron("0 9-17/2 * * *");
  assert(rangeStep.matches(utcDate(2026, 9, 22, 9, 0)));
  assert(rangeStep.matches(utcDate(2026, 9, 22, 11, 0)));
  assert(!rangeStep.matches(utcDate(2026, 9, 22, 10, 0)));
  assert(!rangeStep.matches(utcDate(2026, 9, 22, 18, 0)));
});

Deno.test("FN-2: cron matcher applies day-of-month OR day-of-week semantics", () => {
  // 2026-09-22 is a Tuesday (day 2)
  const domOnly = compileCron("0 0 15 * *");
  const dowOnly = compileCron("0 0 * * 2");
  const both = compileCron("0 0 15 * 2");

  assert(domOnly.matches(utcDate(2026, 9, 15, 0, 0)));
  assert(!domOnly.matches(utcDate(2026, 9, 22, 0, 0)));

  assert(dowOnly.matches(utcDate(2026, 9, 22, 0, 0)));

  // Standard cron: when both dom and dow are restricted, fire on either
  assert(both.matches(utcDate(2026, 9, 15, 0, 0)));
  assert(both.matches(utcDate(2026, 9, 22, 0, 0)));
  assert(!both.matches(utcDate(2026, 9, 16, 0, 0)));
});

Deno.test("FN-2: cron matcher rejects malformed expressions", () => {
  assertThrows(() => compileCron("* * * *"), Error, "5-field");
  assertThrows(() => compileCron("*/0 * * * *"), Error);
  assertThrows(() => compileCron("60 * * * *"), Error);
  assertThrows(() => compileCron("abc * * * *"), Error);
});
