import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { TextbackService } from "../src/service.ts";
import { MemoryStore } from "../src/store.ts";
import { SendFailedError, ValidationError } from "../src/types.ts";
import { missed, setup } from "./helpers.ts";

const HOUR = 3_600_000;

test("a missed call gets exactly one text", async () => {
  const { service, sms } = setup();
  const d = await service.handleCallEvent(missed());
  assert.equal(d.outcome, "sent");
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0]!.to, "+12125550101");
  assert.match(sms.sent[0]!.body, /Reply STOP to opt out/);
});

test("the same provider event id is processed once, however often it arrives", async () => {
  const { service, sms } = setup();
  const event = missed();
  const first = await service.handleCallEvent(event);
  const second = await service.handleCallEvent(event);
  const third = await service.handleCallEvent({ ...event });
  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(third.messageId, first.messageId);
  assert.equal(sms.sent.length, 1);
});

test("concurrent deliveries of one event send one text", async () => {
  const { service, sms } = setup();
  const event = missed();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => service.handleCallEvent(event)));
  assert.equal(sms.sent.length, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.ok(results.every((r) => r.outcome === "sent"));
});

test("no double text: a second missed call from the same caller is skipped", async () => {
  const { service, sms } = setup();
  await service.handleCallEvent(missed());
  const d = await service.handleCallEvent(missed("(212) 555-0101"));
  assert.equal(d.outcome, "skipped_already_texted");
  assert.equal(sms.sent.length, 1);
});

test("no double text holds when two different events race", async () => {
  const { service, sms } = setup();
  const results = await Promise.all([service.handleCallEvent(missed()), service.handleCallEvent(missed())]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["sent", "skipped_already_texted"]);
  assert.equal(sms.sent.length, 1);
});

test("the caller can be texted again once the cooldown has passed", async () => {
  const { service, sms, clock } = setup();
  await service.handleCallEvent(missed());
  clock.t += 23 * HOUR;
  assert.equal((await service.handleCallEvent(missed())).outcome, "skipped_already_texted");
  clock.t += 2 * HOUR; // 25 hours later, 11:00 New York
  assert.equal((await service.handleCallEvent(missed())).outcome, "sent");
  assert.equal(sms.sent.length, 2);
});

test("opted out callers are never texted, and START opts back in", async () => {
  const { service, sms } = setup();
  assert.deepEqual(service.handleInboundSms({ from: "212-555-0101", body: " stop " }), {
    from: "+12125550101",
    optedOut: true,
    changed: true,
  });
  assert.equal((await service.handleCallEvent(missed())).outcome, "skipped_opted_out");
  assert.equal(sms.sent.length, 0);
  assert.equal(service.handleInboundSms({ from: "+12125550101", body: "thanks" }).optedOut, true);
  service.handleInboundSms({ from: "+12125550101", body: "START" });
  assert.equal((await service.handleCallEvent(missed())).outcome, "sent");
});

test("opt out keywords tolerate case, punctuation and spacing, but not longer messages", () => {
  const { service } = setup();
  const phones = ["+12125550101", "+12125550102", "+12125550103", "+12125550104"];
  ["Stop.", '"STOP"', "opt out", "Revoke!"].forEach((body, i) => {
    assert.equal(service.handleInboundSms({ from: phones[i], body }).optedOut, true, body);
  });
  for (const body of ["stop by at 5 please", "can you stop the leak?", "", "ok"]) {
    assert.equal(service.handleInboundSms({ from: "+12125550105", body }).optedOut, false, body);
  }
  assert.equal(service.handleInboundSms({ from: "+12125550101", body: "Start." }).optedOut, false);
});

test("answered calls are ignored", async () => {
  const { service, sms } = setup();
  const d = await service.handleCallEvent(missed("+12125550101", { type: "call.answered" }));
  assert.equal(d.outcome, "ignored_not_missed");
  assert.equal(sms.sent.length, 0);
});

test("quiet hours follow the caller's zone: queued, then sent once at 08:00 local", async () => {
  // 03:30 UTC is 23:30 in New York (quiet) and 20:30 in Los Angeles (fine).
  const { service, sms, clock } = setup("2026-03-12T03:30:00Z");
  const east = await service.handleCallEvent(missed("+12125550101"));
  const west = await service.handleCallEvent(missed("+14155550109"));
  assert.equal(west.outcome, "sent");
  assert.equal(east.outcome, "deferred");
  assert.equal(east.sendAt, "2026-03-12T12:00:00.000Z");
  assert.equal(sms.sent.length, 1);

  // Another call while the text is queued must not queue a second one.
  assert.equal((await service.handleCallEvent(missed("+12125550101"))).outcome, "skipped_already_texted");

  clock.t = Date.parse("2026-03-12T11:59:00Z");
  assert.deepEqual(await service.flushDue(), []);
  clock.t = Date.parse("2026-03-12T12:00:00Z");
  const flushed = await service.flushDue();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.outcome, "sent");
  assert.equal(flushed[0]!.wasDeferred, true);
  assert.equal(sms.sent.length, 2);
  assert.deepEqual(await service.flushDue(), []);
  assert.equal(service.nextDeferredAt(), undefined);

  // The stored decision for the event now reads as sent, and the cooldown starts at the send.
  assert.equal((await service.handleCallEvent({ ...missed(), eventId: east.eventId })).outcome, "sent");
  assert.equal((await service.handleCallEvent(missed("+12125550101"))).outcome, "skipped_already_texted");
});

test("an explicit callerTimeZone on the event beats the area code", async () => {
  const { service } = setup("2026-03-12T03:30:00Z");
  const d = await service.handleCallEvent(missed("+12125550101", { callerTimeZone: "America/Los_Angeles" }));
  assert.equal(d.outcome, "sent");
});

test("a caller who opts out while queued is dropped at release time", async () => {
  const { service, sms, clock } = setup("2026-03-12T03:30:00Z");
  await service.handleCallEvent(missed("+12125550101"));
  service.handleInboundSms({ from: "+12125550101", body: "STOP" });
  clock.t = Date.parse("2026-03-12T12:00:00Z");
  const flushed = await service.flushDue();
  assert.equal(flushed[0]!.outcome, "skipped_opted_out");
  assert.equal(sms.sent.length, 0);
});

test("a failed queued send stays queued and goes out on the next flush", async () => {
  const { service, sms, clock } = setup("2026-03-12T03:30:00Z");
  await service.handleCallEvent(missed("+12125550101"));
  clock.t = Date.parse("2026-03-12T12:00:00Z");
  sms.failNext = 1;
  assert.deepEqual(await service.flushDue(), []);
  assert.equal((await service.flushDue()).length, 1);
  assert.equal(sms.sent.length, 1);
});

test("overlapping flushes send a queued text once, even if the provider ignores idempotency keys", async () => {
  const { config, store, clock } = setup("2026-03-12T03:30:00Z");
  let sends = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  // A slow provider with no idempotency support: every call it receives is a real text.
  const sms = {
    async send() {
      sends++;
      await gate;
      return { messageId: `slow_${sends}` };
    },
  };
  const service = new TextbackService({ store, sms, config, now: () => new Date(clock.t) });
  await service.handleCallEvent(missed("+12125550101"));
  clock.t = Date.parse("2026-03-12T12:00:00Z");
  const first = service.flushDue();
  const second = service.flushDue(); // the next timer tick, while the first send is still in the air
  release();
  assert.equal((await first).length, 1);
  assert.deepEqual(await second, []);
  assert.equal(sends, 1);
  assert.deepEqual(await service.flushDue(), []);
});

test("a provider failure releases the event so the webhook retry sends the text", async () => {
  const { service, sms, store } = setup();
  const event = missed();
  sms.failNext = 1;
  await assert.rejects(service.handleCallEvent(event), SendFailedError);
  assert.equal(store.getDecision(event.eventId), undefined);
  const retry = await service.handleCallEvent(event);
  assert.equal(retry.outcome, "sent");
  assert.equal(retry.duplicate, undefined);
  assert.equal(sms.sent.length, 1);
});

test("malformed events are rejected", async () => {
  const { service } = setup();
  await assert.rejects(service.handleCallEvent(null), ValidationError);
  await assert.rejects(service.handleCallEvent({ type: "call.missed", from: "+12125550101" }), ValidationError);
  await assert.rejects(service.handleCallEvent({ eventId: "e1", type: "call.missed", from: "nope" }), ValidationError);
  await assert.rejects(service.handleCallEvent(missed("+12125550101", { callerTimeZone: "Mars/Olympus" })), ValidationError);
  assert.throws(() => service.handleInboundSms({ body: "STOP" }), ValidationError);
});

test("state survives a restart when STATE_FILE is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "textback-"));
  try {
    const stateFile = join(dir, "state.json");
    const first = setup("2026-03-12T03:30:00Z", { stateFile });
    const day = missed("+14155550109");
    const night = missed("+12125550101");
    await first.service.handleCallEvent(day);
    await first.service.handleCallEvent(night);
    first.service.handleInboundSms({ from: "+13125550104", body: "STOP" });

    const second = setup("2026-03-12T03:31:00Z", { stateFile });
    assert.equal((await second.service.handleCallEvent(day)).duplicate, true);
    assert.equal((await second.service.handleCallEvent(missed("+14155550109"))).outcome, "skipped_already_texted");
    assert.equal((await second.service.handleCallEvent(missed("+13125550104"))).outcome, "skipped_opted_out");
    assert.equal(second.sms.sent.length, 0);
    second.clock.t = Date.parse("2026-03-12T12:00:00Z");
    assert.equal((await second.service.flushDue()).length, 1);
    assert.equal(new MemoryStore(stateFile).pendingDeferred().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config loads defaults and rejects bad values", () => {
  assert.equal(loadConfig({}).smsProvider, "mock");
  assert.equal(loadConfig({ QUIET_START: "22:00", COOLDOWN_HOURS: "12" }).cooldownHours, 12);
  assert.throws(() => loadConfig({ QUIET_END: "8am" }));
  assert.throws(() => loadConfig({ DEFAULT_TIME_ZONE: "Nowhere/Land" }));
  assert.throws(() => loadConfig({ SMS_PROVIDER: "http" }));
});
