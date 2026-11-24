import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatLocal,
  isQuiet,
  nextAllowed,
  normalizePhone,
  parseClock,
  quietWindow,
  timeZoneForPhone,
} from "../src/quietHours.ts";

const night = quietWindow("21:00", "08:00");

test("parseClock accepts HH:MM and rejects junk", () => {
  assert.equal(parseClock("21:30"), 1290);
  assert.throws(() => parseClock("9pm"));
  assert.throws(() => parseClock("24:00"));
});

test("a window that wraps midnight is evaluated in the caller's zone", () => {
  const at = new Date("2026-03-12T03:30:00Z"); // 23:30 New York, 20:30 Los Angeles
  assert.equal(isQuiet(at, "America/New_York", night), true);
  assert.equal(isQuiet(at, "America/Los_Angeles", night), false);
});

test("window edges: start is quiet, end is not", () => {
  assert.equal(isQuiet(new Date("2026-03-12T01:00:00Z"), "America/New_York", night), true); // 21:00
  assert.equal(isQuiet(new Date("2026-03-12T00:59:00Z"), "America/New_York", night), false); // 20:59
  assert.equal(isQuiet(new Date("2026-03-11T12:00:00Z"), "America/New_York", night), false); // 08:00
  assert.equal(isQuiet(new Date("2026-03-11T11:59:00Z"), "America/New_York", night), true); // 07:59
});

test("a same day window and an empty window", () => {
  const lunch = quietWindow("12:00", "13:00");
  assert.equal(isQuiet(new Date("2026-03-11T16:30:00Z"), "America/New_York", lunch), true);
  assert.equal(isQuiet(new Date("2026-03-11T18:00:00Z"), "America/New_York", lunch), false);
  assert.equal(isQuiet(new Date("2026-03-11T16:30:00Z"), "America/New_York", quietWindow("00:00", "00:00")), false);
});

test("nextAllowed returns the local end of quiet hours", () => {
  const at = new Date("2026-03-12T03:40:25Z"); // 23:40:25 New York
  const next = nextAllowed(at, "America/New_York", night);
  assert.equal(next.toISOString(), "2026-03-12T12:00:00.000Z");
  assert.equal(formatLocal(next, "America/New_York"), "08:00 EDT");
});

test("nextAllowed leaves an allowed time untouched", () => {
  const at = new Date("2026-03-11T15:00:00Z");
  assert.equal(nextAllowed(at, "America/New_York", night), at);
});

test("nextAllowed lands on 08:00 local across both daylight saving changes", () => {
  // Spring forward, 2026-03-08: 23:00 EST the night before.
  const spring = nextAllowed(new Date("2026-03-08T04:00:00Z"), "America/New_York", night);
  assert.equal(spring.toISOString(), "2026-03-08T12:00:00.000Z");
  assert.equal(formatLocal(spring, "America/New_York"), "08:00 EDT");
  // Fall back, 2026-11-01: 23:00 EDT the night before.
  const fall = nextAllowed(new Date("2026-11-01T03:00:00Z"), "America/New_York", night);
  assert.equal(fall.toISOString(), "2026-11-01T13:00:00.000Z");
  assert.equal(formatLocal(fall, "America/New_York"), "08:00 EST");
});

test("time zone is inferred from the area code with a fallback", () => {
  assert.equal(timeZoneForPhone("+18085550112", "America/New_York"), "Pacific/Honolulu");
  assert.equal(timeZoneForPhone("+19995550100", "America/Chicago"), "America/Chicago");
});

test("normalizePhone handles common formats", () => {
  assert.equal(normalizePhone("(212) 555-0101"), "+12125550101");
  assert.equal(normalizePhone("1-212-555-0101"), "+12125550101");
  assert.equal(normalizePhone("+12125550101"), "+12125550101");
  assert.equal(normalizePhone("555-0101"), null);
  assert.equal(normalizePhone(42), null);
});
