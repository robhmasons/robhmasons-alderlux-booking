import { addDays, localParts, localToUtc, tzOffsetMinutes, weekdayOf } from "./time";

export interface Interval {
  from: string; // "HH:MM" local
  to: string; // "HH:MM" local
}

export interface Availability {
  timezone: string;
  weekly: Record<string, Interval[]>; // keys: "monday" ... "sunday"
  dateOverrides?: Record<string, Interval[]>; // "YYYY-MM-DD" -> intervals ([] = unavailable all day)
}

export interface SlotRules {
  durationMin: number;
  stepMin: number; // spacing between possible start times
  minNoticeMin: number; // earliest booking relative to now
  maxDaysAhead: number; // furthest bookable calendar day
  bufferMin: number; // gap required before and after any busy period
}

export interface Busy {
  start: number; // UTC ms
  end: number; // UTC ms
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function intervalsFor(date: string, availability: Availability): Interval[] {
  const override = availability.dateOverrides?.[date];
  if (override) return override;
  return availability.weekly[weekdayOf(date)] ?? [];
}

/** Candidate start instants (UTC ms) for one local calendar date, before busy filtering. */
export function candidateStarts(date: string, availability: Availability, rules: SlotRules): number[] {
  const out: number[] = [];
  const ivs = intervalsFor(date, availability);
  if (!ivs.length) return out;
  // Fast path: if the UTC offset is the same either side of the whole day, no clock change
  // happens on it, so every wall-clock time maps with one fixed offset (keeps CPU well under
  // the Workers free-plan 10 ms limit).
  const [y, m, d] = date.split("-").map(Number);
  const dayUtc = Date.UTC(y, m - 1, d);
  const before = tzOffsetMinutes(dayUtc - 3 * 3600000, availability.timezone);
  const after = tzOffsetMinutes(dayUtc + 27 * 3600000, availability.timezone);
  if (before === after) {
    for (const iv of ivs) {
      const from = minutes(iv.from);
      const to = minutes(iv.to);
      for (let t = from; t + rules.durationMin <= to; t += rules.stepMin) out.push(dayUtc + (t - before) * 60000);
    }
    return out.sort((a, b) => a - b);
  }
  for (const iv of ivs) {
    const from = minutes(iv.from);
    const to = minutes(iv.to);
    for (let t = from; t + rules.durationMin <= to; t += rules.stepMin) {
      const start = localToUtc(date, hhmm(t), availability.timezone);
      if (start === null) continue; // start time does not exist (clocks went forward)
      // The call lasts its real duration; it must still end inside the local window on the same day.
      const endLocal = localParts(start + rules.durationMin * 60000, availability.timezone);
      const endDate = `${endLocal.year}-${String(endLocal.month).padStart(2, "0")}-${String(endLocal.day).padStart(2, "0")}`;
      if (endDate !== date || endLocal.hour * 60 + endLocal.minute > to) continue;
      out.push(start);
    }
  }
  return out.sort((a, b) => a - b);
}

export function overlaps(start: number, end: number, busy: Busy[], bufferMin: number): boolean {
  const pad = bufferMin * 60000;
  return busy.some((b) => start < b.end + pad && end + pad > b.start);
}

/** Available slots grouped by local date. */
export function availableSlots(opts: {
  fromDate: string; // local YYYY-MM-DD
  days: number;
  now: number;
  todayLocal: string; // local YYYY-MM-DD for `now`
  availability: Availability;
  rules: SlotRules;
  busy: Busy[];
}): Record<string, number[]> {
  const { availability, rules } = opts;
  const lastDate = addDays(opts.todayLocal, rules.maxDaysAhead);
  const earliest = opts.now + rules.minNoticeMin * 60000;
  const result: Record<string, number[]> = {};
  for (let i = 0; i < opts.days; i++) {
    const date = addDays(opts.fromDate, i);
    if (date < opts.todayLocal || date > lastDate) continue;
    const slots = candidateStarts(date, availability, rules).filter(
      (s) => s >= earliest && !overlaps(s, s + rules.durationMin * 60000, opts.busy, rules.bufferMin),
    );
    if (slots.length) result[date] = slots;
  }
  return result;
}

/** True if `start` is a valid, currently free slot for the rules. Used to re-check at booking time. */
export function isBookable(start: number, opts: Omit<Parameters<typeof availableSlots>[0], "fromDate" | "days"> & { startLocalDate: string }): boolean {
  const day = availableSlots({ ...opts, fromDate: opts.startLocalDate, days: 1 });
  return (day[opts.startLocalDate] ?? []).includes(start);
}
