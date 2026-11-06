// Busy times from a published calendar link (Outlook.com "Publish calendar" > "Can view when I'm busy").
// No Microsoft app or login: the booking system downloads the private .ics link Robert publishes,
// works out every busy period in the booking window (including repeating appointments), and caches
// the result in D1. The 30-minute cron refreshes the cache; page loads only read it (cheap on CPU).

import type { Busy } from "./slots";
import { localToUtc, addDays, weekdayOf } from "./time";

const WINDOWS_TZ: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "UTC",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Arabian Standard Time": "Asia/Dubai",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
};

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_OCCURRENCES = 5000; // safety cap per series

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Stamp {
  ms: number;
  allDay: boolean;
  tz: string; // IANA zone the wall-clock time belongs to
  date: string; // local YYYY-MM-DD
  time: string; // local HH:MM:SS ("00:00:00" for all-day)
}

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

const WANTED = /^(DTSTART|DTEND|DURATION|RRULE|EXDATE|RECURRENCE-ID|UID|STATUS|TRANSP|X-MICROSOFT-CDO-BUSYSTATUS)[;:]/i;

function parseLine(line: string): Prop | null {
  if (!WANTED.test(line)) return null; // ignore everything the busy check does not need
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 34) quoted = !quoted;
    else if (ch === 58 && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

// Offset cache: one time-zone lookup per (zone, local day) unless the clocks change that day.
const dayOffset = new Map<string, number | null>();
function fastLocalToUtc(date: string, hhmm: string, tz: string): number | null {
  const key = tz + "|" + date;
  let off = dayOffset.get(key);
  if (off === undefined) {
    const a = localToUtc(date, "12:00", tz);
    const b = localToUtc(date, "00:00", tz);
    const c = localToUtc(addDays(date, 1), "00:00", tz);
    const naive = Date.parse(date + "T12:00:00Z");
    off = a !== null && b !== null && c !== null && c - b === 86400000 ? naive - a : null; // null = clock-change day
    if (dayOffset.size > 5000) dayOffset.clear();
    dayOffset.set(key, off);
  }
  if (off === null) return localToUtc(date, hhmm, tz);
  return Date.parse(`${date}T${hhmm}:00Z`) - off;
}

export function ianaFor(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  if (tzid.includes("/") || tzid === "UTC") return tzid;
  return WINDOWS_TZ[tzid] ?? fallback;
}

function parseStamp(value: string, params: Record<string, string>, fallbackTz: string): Stamp | null {
  const v = value.trim();
  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const ms = fastLocalToUtc(date, "00:00", fallbackTz);
    return ms === null ? null : { ms, allDay: true, tz: fallbackTz, date, time: "00:00:00" };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === "Z") return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false, tz: "UTC", date, time };
  const tz = ianaFor(params.TZID, fallbackTz);
  // Nonexistent local times (clocks forward) are moved an hour later, as calendar apps do.
  const ms = fastLocalToUtc(date, time.slice(0, 5), tz) ?? localToUtc(date, `${String(+m[4] + 1).padStart(2, "0")}:${m[5]}`, tz);
  return ms === null ? null : { ms: ms + +m[6] * 1000, allDay: false, tz, date, time };
}

function parseDuration(v: string): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

interface RawEvent {
  uid: string;
  start: Stamp;
  durationMs: number;
  rrule?: Record<string, string>;
  exdates: Set<number>;
  recurrenceId?: number;
  blocking: boolean;
}

function isBlocking(props: Map<string, Prop[]>): boolean {
  const status = props.get("STATUS")?.[0]?.value.toUpperCase();
  if (status === "CANCELLED") return false;
  const busy = props.get("X-MICROSOFT-CDO-BUSYSTATUS")?.[0]?.value.toUpperCase();
  if (busy) return busy !== "FREE";
  const transp = props.get("TRANSP")?.[0]?.value.toUpperCase();
  return transp !== "TRANSPARENT";
}

export function parseEvents(text: string, fallbackTz: string, win?: { from: string; to: string }): RawEvent[] {
  const out: RawEvent[] = [];
  let props: Map<string, Prop[]> | null = null;
  let depth = 0; // nesting inside VEVENT (e.g. VALARM)
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      props = new Map();
      depth = 0;
      continue;
    }
    if (!props) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (line === "END:VEVENT") {
      // Cheap pre-filter on the raw date text, so years of past appointments cost almost nothing.
      if (win && !props.has("RRULE")) {
        const ymd = (k: string) => props!.get(k)?.[0]?.value.slice(0, 8) ?? "";
        const s0 = ymd("DTSTART");
        const e0 = ymd("DTEND") || s0;
        const r0 = ymd("RECURRENCE-ID");
        const inWin = (a: string, b: string) => a <= win.to && b >= win.from;
        if (!inWin(s0, e0) && !(r0 && inWin(r0, r0))) {
          props = null;
          continue;
        }
      }
      const dtstart = props.get("DTSTART")?.[0];
      const start = dtstart && parseStamp(dtstart.value, dtstart.params, fallbackTz);
      if (start) {
        let durationMs = 0;
        const dtend = props.get("DTEND")?.[0];
        const end = dtend && parseStamp(dtend.value, dtend.params, fallbackTz);
        if (end) durationMs = end.ms - start.ms;
        else if (props.get("DURATION")) durationMs = parseDuration(props.get("DURATION")![0].value);
        else if (start.allDay) durationMs = 86400000;
        const rr = props.get("RRULE")?.[0]?.value;
        const rrule = rr ? Object.fromEntries(rr.split(";").map((kv) => kv.split("=") as [string, string])) : undefined;
        const exdates = new Set<number>();
        for (const ex of props.get("EXDATE") ?? []) {
          for (const part of ex.value.split(",")) {
            const s = parseStamp(part, ex.params, fallbackTz);
            if (s) exdates.add(s.ms);
          }
        }
        const rid = props.get("RECURRENCE-ID")?.[0];
        const ridStamp = rid && parseStamp(rid.value, rid.params, fallbackTz);
        out.push({ uid: props.get("UID")?.[0]?.value ?? "", start, durationMs: Math.max(durationMs, 0), rrule, exdates, recurrenceId: ridStamp ? ridStamp.ms : undefined, blocking: isBlocking(props) });
      }
      props = null;
      continue;
    }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (p) {
      const list = props.get(p.name) ?? [];
      list.push(p);
      props.set(p.name, list);
    }
  }
  return out;
}

function untilMs(v: string | undefined, start: Stamp): number {
  if (!v) return Infinity;
  const s = parseStamp(v, {}, start.tz);
  if (!s) return Infinity;
  return s.allDay ? s.ms + 86400000 - 1 : s.ms;
}

function nthWeekdayOfMonth(year: number, month: number, code: string): string | null {
  const m = code.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const wd = DAY_CODES.indexOf(m[2]);
  const days: string[] = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === wd) days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  const pick = n > 0 ? days[n - 1] : days[days.length + n];
  return pick ?? null;
}

/** Local dates of each occurrence, in order, starting from the series' first date. */
function* occurrenceDates(start: Stamp, rule: Record<string, string>, skipTo?: string): Generator<string> {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const byday = rule.BYDAY?.split(",").filter(Boolean);
  // Without COUNT, whole periods before the window can be skipped (no need to count them).
  const jumpDays = (period: number, from: string) => {
    if (!skipTo || rule.COUNT || skipTo <= from) return 0;
    const gap = Math.floor((Date.parse(skipTo + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
    return Math.max(0, Math.floor(gap / period) - 1) * period;
  };
  if (freq === "DAILY") {
    for (let d = addDays(start.date, jumpDays(interval, start.date)); ; d = addDays(d, interval)) yield d;
  } else if (freq === "WEEKLY") {
    const wkst = DAY_CODES.indexOf(rule.WKST ?? "MO");
    const startWd = DAY_CODES.indexOf(weekdayOf(start.date).slice(0, 2).toUpperCase());
    const weekStart = addDays(start.date, -((startWd - wkst + 7) % 7));
    const days = (byday?.length ? byday : [DAY_CODES[startWd]]).map((c) => DAY_CODES.indexOf(c.slice(-2))).filter((x) => x >= 0);
    const offsets = days.map((wd) => (wd - wkst + 7) % 7).sort((a, b) => a - b);
    for (let w = addDays(weekStart, jumpDays(7 * interval, weekStart)); ; w = addDays(w, 7 * interval)) {
      for (const off of offsets) {
        const d = addDays(w, off);
        if (d >= start.date) yield d;
      }
    }
  } else if (freq === "MONTHLY") {
    let y = Number(start.date.slice(0, 4));
    let mo = Number(start.date.slice(5, 7));
    const dom = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : null;
    for (;;) {
      const ds: string[] = [];
      if (byday?.length) {
        const pos = rule.BYSETPOS ? Number(rule.BYSETPOS) : null;
        for (const c of byday) {
          const code = pos !== null && !/\d/.test(c) ? `${pos}${c}` : c;
          const d = nthWeekdayOfMonth(y, mo, code);
          if (d) ds.push(d);
        }
      } else {
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        for (const n of dom ?? [Number(start.date.slice(8, 10))]) {
          const day = n < 0 ? last + n + 1 : n;
          if (day >= 1 && day <= last) ds.push(`${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
        }
      }
      for (const d of ds.sort()) if (d >= start.date) yield d;
      mo += interval;
      while (mo > 12) {
        mo -= 12;
        y++;
      }
    }
  } else if (freq === "YEARLY") {
    const md = start.date.slice(5);
    for (let y = Number(start.date.slice(0, 4)); ; y += interval) {
      const d = `${y}-${md}`;
      if (!Number.isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d) yield d;
    }
  }
}

/** All blocking busy periods that overlap [from, to]. */
export function busyFromIcs(text: string, from: number, to: number, fallbackTz = "Europe/London"): Busy[] {
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const fromDate = ymd(from - 2 * 86400000);
  const toDate = ymd(to + 2 * 86400000);
  const events = parseEvents(text, fallbackTz, { from: fromDate.replace(/-/g, ""), to: toDate.replace(/-/g, "") });
  const overridden = new Set(events.filter((e) => e.recurrenceId !== undefined).map((e) => `${e.uid}|${e.recurrenceId}`));
  const out: Busy[] = [];
  const add = (s: number, e: number) => {
    if (s < to && e > from && e > s) out.push({ start: s, end: e });
  };
  for (const ev of events) {
    if (!ev.rrule || ev.recurrenceId !== undefined) {
      if (ev.blocking) add(ev.start.ms, ev.start.ms + ev.durationMs);
      continue;
    }
    if (!ev.blocking) continue;
    const until = untilMs(ev.rrule.UNTIL, ev.start);
    const count = ev.rrule.COUNT ? Number(ev.rrule.COUNT) : Infinity;
    let n = 0;
    for (const date of occurrenceDates(ev.start, ev.rrule, fromDate)) {
      if (n >= count) break;
      if (date > toDate) break;
      if (date < fromDate) {
        n++; // counts towards COUNT, but needs no time-zone maths
        if (n > 200000) break;
        continue;
      }
      if (n >= MAX_OCCURRENCES + 200000) break;
      const s = ev.start.allDay || ev.start.tz === "UTC"
        ? (ev.start.allDay ? fastLocalToUtc(date, "00:00", ev.start.tz) : Date.parse(`${date}T${ev.start.time}Z`))
        : fastLocalToUtc(date, ev.start.time.slice(0, 5), ev.start.tz);
      n++;
      if (s === null) continue;
      if (s > until || s > to) break;
      if (ev.exdates.has(s) || overridden.has(`${ev.uid}|${s}`)) continue;
      add(s, s + ev.durationMs);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// --- Cache in D1 ------------------------------------------------------------------------------------

const CACHE_KEY = "ics_busy_cache";
export const CACHE_MAX_AGE_MS = 3 * 3600 * 1000; // older than this = treat calendar as unavailable

export async function refreshIcsBusy(db: D1Database, url: string, now: number, f: typeof fetch = fetch): Promise<number> {
  const res = await f(url, { headers: { accept: "text/calendar" }, cf: { cacheTtl: 0 } } as RequestInit);
  if (!res.ok) throw new Error(`Calendar link returned ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Calendar link did not return a calendar");
  const busy = busyFromIcs(text, now - 86400000, now + 75 * 86400000);
  const value = JSON.stringify({ fetched: now, busy: busy.map((b) => [b.start, b.end]) });
  await db.prepare("INSERT INTO settings (key, value, updated_ms) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_ms = ?3").bind(CACHE_KEY, value, now).run();
  return busy.length;
}

export async function cachedIcsBusy(db: D1Database, now: number): Promise<{ busy: Busy[]; fetched: number } | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CACHE_KEY).first<{ value: string }>();
  if (!row) return null;
  const j = JSON.parse(row.value) as { fetched: number; busy: [number, number][] };
  if (now - j.fetched > CACHE_MAX_AGE_MS) return null;
  return { fetched: j.fetched, busy: j.busy.map(([start, end]) => ({ start, end })) };
}
