// Time-zone helpers using only Intl (no dependencies). All instants are UTC epoch milliseconds.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: string; // "monday" ... "sunday"
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday").toLowerCase(),
  };
}

/** Offset of tz from UTC at the given instant, in minutes (e.g. +60 for BST). */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/**
 * Convert a wall-clock time in tz to a UTC instant.
 * Returns null for times that do not exist (the hour skipped when clocks go forward).
 */
export function localToUtc(date: string, time: string, tz: string): number | null {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive - tzOffsetMinutes(naive, tz) * 60000;
  guess = naive - tzOffsetMinutes(guess, tz) * 60000;
  const back = localParts(guess, tz);
  if (back.year !== y || back.month !== m || back.day !== d || back.hour !== hh || back.minute !== mm) return null;
  return guess;
}

/** Calendar date string YYYY-MM-DD of an instant in tz. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Add whole days to a YYYY-MM-DD string (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}
