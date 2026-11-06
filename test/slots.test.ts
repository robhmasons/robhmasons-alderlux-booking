import { describe, expect, it } from "vitest";
import { availableSlots, candidateStarts, isBookable, overlaps, type Availability, type SlotRules } from "../src/slots";
import { localToUtc, localDate, addDays, weekdayOf, tzOffsetMinutes } from "../src/time";
import { TENANTS } from "../src/config";

const TZ = "Europe/London";
const iso = (ms: number) => new Date(ms).toISOString();
const rules: SlotRules = { durationMin: 60, stepMin: 30, minNoticeMin: 0, maxDaysAhead: 365, bufferMin: 0 };

describe("time helpers", () => {
  it("converts UK winter and summer wall-clock times correctly", () => {
    expect(iso(localToUtc("2026-01-15", "09:00", TZ)!)).toBe("2026-01-15T09:00:00.000Z"); // GMT
    expect(iso(localToUtc("2026-07-15", "09:00", TZ)!)).toBe("2026-07-15T08:00:00.000Z"); // BST
    expect(tzOffsetMinutes(Date.parse("2026-07-15T12:00:00Z"), TZ)).toBe(60);
  });

  it("returns null for the hour skipped when clocks go forward (29 March 2026)", () => {
    expect(localToUtc("2026-03-29", "01:30", TZ)).toBeNull();
    expect(iso(localToUtc("2026-03-29", "02:30", TZ)!)).toBe("2026-03-29T01:30:00.000Z");
  });

  it("handles the repeated hour when clocks go back (25 October 2026)", () => {
    expect(localToUtc("2026-10-25", "01:30", TZ)).not.toBeNull();
    expect(iso(localToUtc("2026-10-25", "03:00", TZ)!)).toBe("2026-10-25T03:00:00.000Z");
  });

  it("does calendar arithmetic and weekdays", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayOf("2026-11-06")).toBe("friday");
    expect(localDate(Date.parse("2026-07-01T23:30:00Z"), TZ)).toBe("2026-07-02");
  });
});

describe("slot generation", () => {
  const avail: Availability = { timezone: TZ, weekly: { monday: [{ from: "09:00", to: "11:00" }] } };

  it("generates starts every step that fit the duration", () => {
    const s = candidateStarts("2026-11-09", avail, rules).map(iso); // a Monday, GMT
    expect(s).toEqual(["2026-11-09T09:00:00.000Z", "2026-11-09T09:30:00.000Z", "2026-11-09T10:00:00.000Z"]);
  });

  it("returns nothing on days with no rule", () => {
    expect(candidateStarts("2026-11-10", avail, rules)).toEqual([]);
  });

  it("uses date overrides, including an empty override as a day off", () => {
    const a: Availability = { ...avail, dateOverrides: { "2026-11-09": [] } };
    expect(candidateStarts("2026-11-09", a, rules)).toEqual([]);
  });

  it("never offers a start in the hour skipped by the spring clock change", () => {
    const a: Availability = { timezone: TZ, weekly: { sunday: [{ from: "00:00", to: "04:00" }] } };
    const s = candidateStarts("2026-03-29", a, rules).map(iso);
    // Local 00:00 and 00:30 are GMT; 01:00-01:59 local does not exist; 02:00 onwards is BST.
    expect(s).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-29T00:30:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-29T02:00:00.000Z"]);
  });

  it("keeps real call length inside the window across the autumn clock change", () => {
    const a: Availability = { timezone: TZ, weekly: { sunday: [{ from: "00:00", to: "02:00" }] } };
    const s = candidateStarts("2026-10-25", a, rules).map(iso);
    // 00:00 BST = 23:00Z; the extra hour means more real time fits before local 02:00 GMT.
    expect(s[0]).toBe("2026-10-24T23:00:00.000Z");
    expect(s.every((x) => Date.parse(x) + 3600000 <= Date.parse("2026-10-25T02:00:00Z"))).toBe(true);
  });

  it("applies minimum notice, the booking horizon and busy periods with buffer", () => {
    const now = Date.parse("2026-11-09T08:00:00Z");
    const busy = [{ start: Date.parse("2026-11-09T10:30:00Z"), end: Date.parse("2026-11-09T11:00:00Z") }];
    const out = availableSlots({ fromDate: "2026-11-09", days: 8, now, todayLocal: "2026-11-09", availability: avail, rules: { ...rules, minNoticeMin: 75, bufferMin: 15, maxDaysAhead: 7 }, busy });
    // 09:00 is inside the notice window; 10:00 ends 11:00, overlapping busy 10:30; 09:30 ends 10:30 but the 15-min buffer blocks it.
    expect(out["2026-11-09"]).toBeUndefined();
    expect(out["2026-11-16"].map(iso)).toEqual(["2026-11-16T09:00:00.000Z", "2026-11-16T09:30:00.000Z", "2026-11-16T10:00:00.000Z"]);
    const beyond = availableSlots({ fromDate: "2026-11-23", days: 1, now, todayLocal: "2026-11-09", availability: avail, rules: { ...rules, maxDaysAhead: 7 }, busy: [] });
    expect(beyond).toEqual({});
  });

  it("overlap treats touching periods as free when buffer is zero", () => {
    expect(overlaps(0, 10, [{ start: 10, end: 20 }], 0)).toBe(false);
    expect(overlaps(0, 11, [{ start: 10, end: 20 }], 0)).toBe(true);
  });

  it("isBookable rejects times that are not real slots", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const base = { now, todayLocal: "2026-11-01", availability: avail, rules, busy: [], startLocalDate: "2026-11-09" };
    expect(isBookable(Date.parse("2026-11-09T09:30:00Z"), base)).toBe(true);
    expect(isBookable(Date.parse("2026-11-09T09:15:00Z"), base)).toBe(false);
    expect(isBookable(Date.parse("2026-11-09T10:30:00Z"), base)).toBe(false);
  });
});

describe("Alderlux configuration", () => {
  const t = TENANTS.alderlux;
  it("matches the Calendly working hours copied on 06/11/2026", () => {
    expect(t.availability.weekly.tuesday).toEqual([{ from: "06:15", to: "07:00" }, { from: "09:30", to: "13:00" }, { from: "20:00", to: "23:45" }]);
    expect(t.availability.dateOverrides?.["2026-12-05"]).toHaveLength(2);
  });

  it("a 60-minute call never fits the 45-minute early window", () => {
    const s = candidateStarts("2026-11-10", t.availability, { ...t.rules, durationMin: 60 }).map((ms) => new Date(ms).toISOString());
    expect(s[0]).toBe("2026-11-10T09:30:00.000Z");
    expect(s.at(-1)).toBe("2026-11-10T22:30:00.000Z");
  });

  it("every event type asks how the person heard about Alderlux", () => {
    for (const et of t.eventTypes) expect(et.questions.some((q) => q.id === "heard_about" && q.required)).toBe(true);
  });

  it("carries the approved footer verbatim", () => {
    expect(t.footer[0]).toBe("Alderlux provides education and information only. We do not provide regulated financial advice, investment recommendations, legal or tax advice. Alderlux is not authorised by the Financial Conduct Authority.");
  });
});
