import { DEFAULT_CONFIG, type Config } from "./config.ts";
import { formatLocal, isQuiet, quietWindow, timeZoneForPhone } from "./quietHours.ts";
import { TextbackService } from "./service.ts";
import { MockSmsProvider, type SentMessage } from "./sms.ts";
import { MemoryStore } from "./store.ts";
import type { Decision } from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Midnight US Eastern on a fixed, made up day.
const DAY_START = Date.parse("2026-03-11T04:00:00Z");
const BUSINESS_TZ = "America/New_York";

interface Caller {
  name: string;
  phone: string;
}

// Entirely synthetic people on reserved 555-01xx numbers.
const RANDOM_CALLERS: Caller[] = [
  { name: "Alex Sample", phone: "+12125550101" },
  { name: "Blair Example", phone: "+12125550102" },
  { name: "Casey Placeholder", phone: "+16175550103" },
  { name: "Devon Testcase", phone: "+13125550104" },
  { name: "Emery Mockwell", phone: "+13125550105" },
  { name: "Finley Sample", phone: "+15125550106" },
  { name: "Gray Example", phone: "+13035550107" },
  { name: "Harper Fixture", phone: "+15055550108" },
  { name: "Indigo Sample", phone: "+14155550109" },
  { name: "Jules Example", phone: "+12065550110" },
  { name: "Kit Placeholder", phone: "+15035550111" },
];
const NIGHT_OWL: Caller = { name: "Lane Nightowl", phone: "+18085550112" };
const STOPPER: Caller = { name: "Morgan Stopper", phone: "+12125550113" };
const LATE_WEST: Caller = { name: "Noel Latecall", phone: "+14155550114" };
const LATE_EAST: Caller = { name: "Oakley Latecall", phone: "+16175550115" };
const QUEUED_STOPPER: Caller = { name: "Parker Changedmind", phone: "+13035550116" };
const SCRIPTED = [NIGHT_OWL, STOPPER, LATE_WEST, LATE_EAST, QUEUED_STOPPER];
const PRE_OPTED_OUT = ["+13125550105", "+15035550111"];

export interface SimItem {
  at: number;
  kind: "call" | "sms";
  caller: Caller;
  payload: Record<string, unknown>;
  redelivery?: boolean;
}

export interface SimCheck {
  name: string;
  ok: boolean;
}

export interface SimResult {
  lines: string[];
  items: SimItem[];
  decisions: Decision[];
  sent: SentMessage[];
  counts: Record<string, number>;
  checks: SimCheck[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds one day of fake provider traffic: random calls, webhook redeliveries and a few scripted edge cases. */
export function generateDay(seed = 42): SimItem[] {
  const rng = mulberry32(seed);
  const calls: { at: number; caller: Caller; type: string }[] = [];
  const add = (caller: Caller, minuteOfDay: number, type = "call.missed") =>
    calls.push({ at: DAY_START + Math.round(minuteOfDay) * MINUTE, caller, type });

  for (const caller of RANDOM_CALLERS) {
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const minute = rng() < 0.65 ? 8 * 60 + rng() * 10 * 60 : rng() * 1440;
      add(caller, minute, rng() < 0.2 ? "call.answered" : "call.missed");
    }
  }
  add(NIGHT_OWL, 7 * 60 + 30); // 01:30 in Honolulu: queued until 08:00 local
  add(NIGHT_OWL, 10 * 60); // still queued: second call must not queue another text
  add(STOPPER, 9 * 60 + 5); // texted, then replies STOP
  add(STOPPER, 15 * 60); // opted out by now
  add(LATE_WEST, 23 * 60 + 30); // 20:30 Pacific: still fine to text
  add(LATE_EAST, 23 * 60 + 40); // 23:40 Eastern: queued for the morning
  add(QUEUED_STOPPER, 23 * 60 + 50); // 21:50 Mountain: queued, then opts out before it sends

  calls.sort((a, b) => a.at - b.at);
  const items: SimItem[] = [];
  calls.forEach((c, i) => {
    const payload = {
      eventId: `evt_${String(i + 1).padStart(4, "0")}`,
      type: c.type,
      from: c.caller.phone,
      to: DEFAULT_CONFIG.businessLine,
      occurredAt: new Date(c.at).toISOString(),
    };
    items.push({ at: c.at, kind: "call", caller: c.caller, payload });
    if (rng() < 0.2) {
      // The provider delivers the same event again, as real webhooks do.
      const delay = (5 + Math.floor(rng() * 115)) * 1000;
      items.push({ at: c.at + delay, kind: "call", caller: c.caller, payload, redelivery: true });
    }
  });
  const sms = (caller: Caller, minuteOfDay: number, body: string) =>
    items.push({ at: DAY_START + minuteOfDay * MINUTE, kind: "sms", caller, payload: { from: caller.phone, body } });
  sms(STOPPER, 9 * 60 + 20, "STOP");
  sms(QUEUED_STOPPER, 23 * 60 + 55, "stop");
  return items.sort((a, b) => a.at - b.at);
}

/** Replays a generated day against the real service with a virtual clock and the mock SMS provider. */
export async function replayDay(seed = 42, overrides: Partial<Config> = {}): Promise<SimResult> {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  const clock = { t: DAY_START };
  const now = () => new Date(clock.t);
  const store = new MemoryStore();
  const sms = new MockSmsProvider(now);
  const service = new TextbackService({ store, sms, config, now });
  const window = quietWindow(config.quietStart, config.quietEnd);
  const tzOf = (phone: string) => timeZoneForPhone(phone, config.defaultTimeZone);
  const names = new Map([...RANDOM_CALLERS, ...SCRIPTED].map((c) => [c.phone, c.name]));
  const optOutAt = new Map<string, number>();
  const lines: string[] = [];
  const log = (kind: string, id: string, phone: string, result: string) => {
    const who = `${names.get(phone) ?? "?"} ${phone}`;
    lines.push(
      `${formatLocal(now(), BUSINESS_TZ)} | ${kind.padEnd(13)} | ${id.padEnd(8)} | ${who.padEnd(31)} | ${formatLocal(now(), tzOf(phone)).padEnd(12)} | ${result}`,
    );
  };

  for (const phone of PRE_OPTED_OUT) {
    store.setOptOut(phone, true);
    optOutAt.set(phone, 0);
  }

  // Advance the clock to each queued text's release time, like the 30 second flush loop would.
  const drainUntil = async (t: number) => {
    for (let guard = 0; guard < 1000; guard++) {
      const next = service.nextDeferredAt();
      if (next === undefined || next > t) return;
      clock.t = Math.max(clock.t, next);
      for (const d of await service.flushDue()) {
        log("queue release", d.eventId, d.to, d.outcome === "sent" ? `SENT ${d.messageId} (was queued)` : `DROPPED: ${d.reason}`);
      }
    }
  };

  const items = generateDay(seed);
  let redeliveries = 0;
  for (const item of items) {
    await drainUntil(item.at);
    clock.t = item.at;
    if (item.kind === "sms") {
      const r = service.handleInboundSms(item.payload);
      if (r.optedOut && r.changed) optOutAt.set(r.from, clock.t);
      log("sms inbound", "", r.from, `"${String(item.payload.body)}" -> ${r.optedOut ? "opted out" : "no change"}`);
      continue;
    }
    const d = await service.handleCallEvent(item.payload);
    if (d.duplicate) redeliveries++;
    let result: string = d.outcome.toUpperCase();
    if (d.duplicate) result = `DUPLICATE DELIVERY, no action (first result: ${d.outcome})`;
    else if (d.outcome === "sent") result = `SENT ${d.messageId}`;
    else if (d.outcome === "deferred") result = `QUEUED until ${formatLocal(new Date(d.sendAt!), d.timeZone!)} (${d.reason})`;
    else result = `${result}: ${d.reason}`;
    log(String(item.payload.type), d.eventId, d.to, result);
  }
  await drainUntil(DAY_START + 48 * HOUR);

  const decisions = store.allDecisions();
  const counts: Record<string, number> = { deliveries: items.filter((i) => i.kind === "call").length, redeliveries };
  for (const d of decisions) counts[d.outcome] = (counts[d.outcome] ?? 0) + 1;

  const uniqueIds = new Set(items.filter((i) => i.kind === "call").map((i) => String(i.payload.eventId)));
  const perPhone = new Map<string, number[]>();
  for (const m of sms.sent) perPhone.set(m.to, [...(perPhone.get(m.to) ?? []), m.sentAt.getTime()]);
  const cooldownMs = config.cooldownHours * HOUR;
  const eligible = new Set(
    items
      .filter((i) => i.kind === "call" && i.payload.type === "call.missed" && !optOutAt.has(i.caller.phone))
      .map((i) => i.caller.phone),
  );
  const checks: SimCheck[] = [
    { name: "one decision per provider event id", ok: decisions.length === uniqueIds.size },
    {
      name: "redeliveries sent nothing extra",
      ok: sms.sent.length === (counts.sent ?? 0) && new Set(sms.sent.map((m) => m.idempotencyKey)).size === sms.sent.length,
    },
    {
      name: "no number texted twice inside the cooldown window",
      ok: [...perPhone.values()].every((ts) => ts.every((t, i) => i === 0 || t - ts[i - 1]! >= cooldownMs)),
    },
    { name: "no text sent during the recipient's quiet hours", ok: sms.sent.every((m) => !isQuiet(m.sentAt, tzOf(m.to), window)) },
    {
      name: "no text sent to a number after it opted out",
      ok: sms.sent.every((m) => !optOutAt.has(m.to) || m.sentAt.getTime() < optOutAt.get(m.to)!),
    },
    {
      name: "every caller with a missed call who never opted out got exactly one text",
      ok: [...eligible].every((p) => perPhone.get(p)?.length === 1),
    },
  ];
  return { lines, items, decisions, sent: sms.sent, counts, checks };
}

export function formatReport(result: SimResult, seed: number): string {
  const out: string[] = [];
  out.push(`Missed call text back simulator, seed ${seed}`);
  out.push("One synthetic day of provider webhooks replayed against the real service with a virtual clock.");
  out.push("Quiet hours 21:00 to 08:00 caller local time. Cooldown 24 hours. All people and numbers are fake.");
  out.push("");
  out.push("Eastern   | event         | event id | caller                          | caller local | result");
  out.push("-".repeat(118));
  out.push(...result.lines);
  out.push("");
  out.push("Summary");
  for (const [k, v] of Object.entries(result.counts)) out.push(`  ${k.padEnd(24)} ${v}`);
  out.push(`  ${"texts actually sent".padEnd(24)} ${result.sent.length}`);
  out.push("");
  out.push("Invariant checks");
  for (const c of result.checks) out.push(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}`);
  return out.join("\n");
}
