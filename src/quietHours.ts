export interface QuietWindow {
  startMin: number;
  endMin: number;
}

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "21:30" to minutes after midnight. */
export function parseClock(text: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) throw new Error(`Invalid clock time "${text}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function quietWindow(start: string, end: string): QuietWindow {
  return { startMin: parseClock(start), endMin: parseClock(end) };
}

function parts(at: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** Minutes after local midnight in the given zone. */
export function localMinutes(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Wall clock label such as "08:00 EDT", used in logs and the simulator. */
export function formatLocal(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.hour}:${p.minute} ${p.timeZoneName}`;
}

export function isQuiet(at: Date, timeZone: string, w: QuietWindow): boolean {
  if (w.startMin === w.endMin) return false;
  const m = localMinutes(at, timeZone);
  return w.startMin < w.endMin ? m >= w.startMin && m < w.endMin : m >= w.startMin || m < w.endMin;
}

/** The first instant at or after `at` that is outside quiet hours in the zone. */
export function nextAllowed(at: Date, timeZone: string, w: QuietWindow): Date {
  if (!isQuiet(at, timeZone, w)) return at;
  const floored = Math.floor(at.getTime() / MINUTE) * MINUTE;
  const wait = (w.endMin - localMinutes(at, timeZone) + 1440) % 1440;
  let candidate = floored + wait * MINUTE;
  // A daylight saving shift inside the wait can leave the estimate off by up to an hour. Walk it in.
  for (let i = 0; i < 180 && isQuiet(new Date(candidate), timeZone, w); i++) candidate += MINUTE;
  for (let i = 0; i < 180; i++) {
    const earlier = candidate - MINUTE;
    if (earlier <= at.getTime() || isQuiet(new Date(earlier), timeZone, w)) break;
    candidate = earlier;
  }
  return new Date(candidate);
}

// A deliberately small sample of North American area codes. Unknown codes use the fallback zone.
const AREA_CODE_ZONES: Record<string, string> = {
  "212": "America/New_York",
  "617": "America/New_York",
  "404": "America/New_York",
  "312": "America/Chicago",
  "512": "America/Chicago",
  "615": "America/Chicago",
  "303": "America/Denver",
  "505": "America/Denver",
  "602": "America/Phoenix",
  "415": "America/Los_Angeles",
  "206": "America/Los_Angeles",
  "503": "America/Los_Angeles",
  "907": "America/Anchorage",
  "808": "Pacific/Honolulu",
};

export function timeZoneForPhone(phone: string, fallback: string): string {
  const m = /^\+1(\d{3})\d{7}$/.exec(phone);
  return (m && AREA_CODE_ZONES[m[1]!]) || fallback;
}

/** Normalizes common US formats to E.164. Returns null when the input is not a phone number. */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
