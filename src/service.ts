import type { Config } from "./config.ts";
import {
  isQuiet,
  isValidTimeZone,
  nextAllowed,
  normalizePhone,
  quietWindow,
  timeZoneForPhone,
  type QuietWindow,
} from "./quietHours.ts";
import type { MemoryStore } from "./store.ts";
import {
  SendFailedError,
  ValidationError,
  type CallEvent,
  type Decision,
  type SmsProvider,
} from "./types.ts";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP"]);

export interface ServiceDeps {
  store: MemoryStore;
  sms: SmsProvider;
  config: Config;
  now?: () => Date;
}

export function parseCallEvent(raw: unknown): CallEvent {
  if (typeof raw !== "object" || raw === null) throw new ValidationError("body must be a JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.eventId !== "string" || !r.eventId.trim()) throw new ValidationError("eventId is required");
  if (typeof r.type !== "string" || !r.type) throw new ValidationError("type is required");
  const from = normalizePhone(r.from);
  if (!from) throw new ValidationError("from must be a phone number");
  const tz = r.callerTimeZone;
  if (tz !== undefined && (typeof tz !== "string" || !isValidTimeZone(tz))) {
    throw new ValidationError("callerTimeZone must be an IANA time zone");
  }
  return {
    eventId: r.eventId.trim(),
    type: r.type,
    from,
    to: normalizePhone(r.to) ?? "",
    occurredAt: typeof r.occurredAt === "string" ? r.occurredAt : "",
    callerTimeZone: tz,
  };
}

export class TextbackService {
  private store: MemoryStore;
  private sms: SmsProvider;
  private config: Config;
  private now: () => Date;
  private window: QuietWindow;
  private inFlight = new Map<string, Promise<Decision>>();

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.sms = deps.sms;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.window = quietWindow(deps.config.quietStart, deps.config.quietEnd);
  }

  /** Handles one provider call event. Safe to call any number of times with the same event id. */
  async handleCallEvent(raw: unknown): Promise<Decision> {
    const event = parseCallEvent(raw);
    const prior = this.store.getDecision(event.eventId);
    if (prior) return { ...prior, duplicate: true };
    const running = this.inFlight.get(event.eventId);
    if (running) return { ...(await running), duplicate: true };

    // decide() runs synchronously up to its first await, so the caller is reserved
    // before any other event can be looked at.
    const pending = this.decide(event);
    this.inFlight.set(event.eventId, pending);
    try {
      const decision = await pending;
      this.store.saveDecision(decision);
      return decision;
    } finally {
      this.inFlight.delete(event.eventId);
    }
  }

  private async decide(event: CallEvent): Promise<Decision> {
    const now = this.now();
    const phone = event.from;
    const base = { eventId: event.eventId, to: phone, decidedAt: now.toISOString() };

    if (event.type !== "call.missed") {
      return { ...base, outcome: "ignored_not_missed", reason: `event type ${event.type} needs no text` };
    }
    if (this.store.isOptedOut(phone)) {
      return { ...base, outcome: "skipped_opted_out", reason: "caller is on the opt out list" };
    }
    const last = this.store.getLastText(phone);
    const cooldownMs = this.config.cooldownHours * 3_600_000;
    if (last !== undefined && now.getTime() - last < cooldownMs) {
      const reason = last > now.getTime() ? "a text to this caller is already queued" : "caller was already texted inside the cooldown window";
      return { ...base, outcome: "skipped_already_texted", reason };
    }

    const timeZone = event.callerTimeZone ?? timeZoneForPhone(phone, this.config.defaultTimeZone);
    if (isQuiet(now, timeZone, this.window)) {
      const sendAt = nextAllowed(now, timeZone, this.window);
      this.store.addDeferred({ eventId: event.eventId, to: phone, timeZone, sendAt: sendAt.getTime(), attempts: 0 });
      this.store.setLastText(phone, sendAt.getTime());
      return { ...base, outcome: "deferred", reason: "quiet hours for the caller", timeZone, sendAt: sendAt.toISOString() };
    }

    this.store.setLastText(phone, now.getTime());
    try {
      const { messageId } = await this.send(phone, event.eventId);
      return { ...base, outcome: "sent", reason: "missed call", timeZone, messageId, sentAt: now.toISOString() };
    } catch (err) {
      // Release the reservation so the provider's retry of this event can succeed.
      this.store.setLastText(phone, last);
      throw new SendFailedError(`text back failed: ${(err as Error).message}`);
    }
  }

  /** Sends queued texts whose quiet hours have ended. Returns the decisions that changed. */
  async flushDue(): Promise<Decision[]> {
    const now = this.now();
    const changed: Decision[] = [];
    for (const item of this.store.dueDeferred(now.getTime())) {
      const base = this.store.getDecision(item.eventId) ?? {
        eventId: item.eventId,
        to: item.to,
        decidedAt: now.toISOString(),
        outcome: "deferred" as const,
        reason: "",
      };
      if (this.store.isOptedOut(item.to)) {
        this.store.removeDeferred(item.eventId);
        this.store.setLastText(item.to, undefined);
        changed.push({ ...base, outcome: "skipped_opted_out", reason: "caller opted out while the text was queued", wasDeferred: true });
      } else if (isQuiet(now, item.timeZone, this.window)) {
        item.sendAt = nextAllowed(now, item.timeZone, this.window).getTime();
        this.store.setLastText(item.to, item.sendAt);
        continue;
      } else {
        try {
          const { messageId } = await this.send(item.to, item.eventId);
          this.store.removeDeferred(item.eventId);
          this.store.setLastText(item.to, now.getTime());
          changed.push({ ...base, outcome: "sent", reason: "missed call, sent after quiet hours", messageId, sentAt: now.toISOString(), wasDeferred: true });
        } catch {
          item.attempts++;
          this.store.persist();
          continue;
        }
      }
      this.store.saveDecision(changed[changed.length - 1]!);
    }
    return changed;
  }

  /** Epoch ms of the earliest queued text, if any. */
  nextDeferredAt(): number | undefined {
    const times = this.store.pendingDeferred().map((d) => d.sendAt);
    return times.length ? Math.min(...times) : undefined;
  }

  /** Inbound text from a caller. STOP style keywords opt out, START opts back in. */
  handleInboundSms(raw: unknown): { from: string; optedOut: boolean; changed: boolean } {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const from = normalizePhone(r.from);
    if (!from) throw new ValidationError("from must be a phone number");
    const word = typeof r.body === "string" ? r.body.trim().toUpperCase() : "";
    const before = this.store.isOptedOut(from);
    if (STOP_WORDS.has(word)) this.store.setOptOut(from, true);
    else if (START_WORDS.has(word)) this.store.setOptOut(from, false);
    const optedOut = this.store.isOptedOut(from);
    return { from, optedOut, changed: optedOut !== before };
  }

  private send(to: string, eventId: string): Promise<{ messageId: string }> {
    const body = `Hi, this is ${this.config.businessName}. Sorry we missed your call. Reply here and we will get right back to you. Reply STOP to opt out.`;
    return this.sms.send({ to, from: this.config.businessLine, body, idempotencyKey: eventId });
  }
}
