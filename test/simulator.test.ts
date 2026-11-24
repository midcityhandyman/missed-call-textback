import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport, generateDay, replayDay } from "../src/simulator.ts";

test("the generated day is deterministic and contains redeliveries", () => {
  const a = generateDay(42);
  assert.deepEqual(a, generateDay(42));
  assert.notDeepEqual(a, generateDay(43));
  assert.ok(a.some((i) => i.redelivery));
  assert.ok(a.some((i) => i.kind === "sms"));
});

test("every invariant holds across many seeds", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const result = await replayDay(seed);
    for (const check of result.checks) assert.ok(check.ok, `seed ${seed}: ${check.name}`);
  }
});

test("the default day shows every outcome and the scripted edge cases", async () => {
  const result = await replayDay(42);
  for (const key of ["sent", "skipped_opted_out", "skipped_already_texted", "ignored_not_missed"]) {
    assert.ok((result.counts[key] ?? 0) > 0, key);
  }
  assert.ok((result.counts.redeliveries ?? 0) > 0);
  assert.equal(result.counts.deferred, undefined, "nothing is left queued at the end");
  assert.equal(result.sent.length, result.counts.sent);
  const report = formatReport(result, 42);
  assert.match(report, /QUEUED until 08:00 HST/);
  assert.match(report, /DROPPED: caller opted out while the text was queued/);
  assert.doesNotMatch(report, /FAIL/);
});
