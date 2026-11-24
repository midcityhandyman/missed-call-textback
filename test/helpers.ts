import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { TextbackService } from "../src/service.ts";
import { MockSmsProvider } from "../src/sms.ts";
import { MemoryStore } from "../src/store.ts";

/** 2026-03-11 14:00 UTC is 10:00 in New York: daytime in every continental US zone. */
export const NOON_ISH = "2026-03-11T14:00:00Z";

export function setup(startIso = NOON_ISH, overrides: Partial<Config> = {}) {
  const clock = { t: Date.parse(startIso) };
  const now = () => new Date(clock.t);
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  const store = new MemoryStore(config.stateFile);
  const sms = new MockSmsProvider(now);
  const service = new TextbackService({ store, sms, config, now });
  return { clock, config, store, sms, service };
}

let counter = 0;
export function missed(from = "+12125550101", extra: Record<string, unknown> = {}) {
  return { eventId: `evt_test_${++counter}`, type: "call.missed", from, to: "+12125550100", occurredAt: NOON_ISH, ...extra };
}
