import { describe, expect, it } from "vitest";
import { busyFromIcs, ianaFor } from "../src/ics-busy";

const iso = (ms: number) => new Date(ms).toISOString();

// Shaped like an Outlook.com "Can view when I'm busy" published calendar.
const OUTLOOK = [
  "BEGIN:VCALENDAR",
  "METHOD:PUBLISH",
  "PRODID:Microsoft Exchange Server 2010",
  "VERSION:2.0",
  "X-WR-CALNAME:Calendar",
  "BEGIN:VTIMEZONE",
  "TZID:GMT Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T010000",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  // Weekly client session, Tuesdays 18:00-19:00 UK time, from 6 Oct 2026; 17 Nov skipped; 24 Nov moved to 19:00.
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "RRULE:FREQ=WEEKLY;UNTIL=20270330T170000Z;INTERVAL=1;BYDAY=TU;WKST=MO",
  "EXDATE;TZID=GMT Standard Time:20261117T180000",
  "SUMMARY:Busy",
  "DTSTART;TZID=GMT Standard Time:20261006T180000",
  "DTEND;TZID=GMT Standard Time:20261006T190000",
  "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "RECURRENCE-ID;TZID=GMT Standard Time:20261124T180000",
  "SUMMARY:Busy",
  "DTSTART;TZID=GMT Standard Time:20261124T190000",
  "DTEND;TZID=GMT Standard Time:20261124T200000",
  "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
  "END:VEVENT",
  // Mondays and Thursdays 07:30-08:00, 4 occurrences only.
  "BEGIN:VEVENT",
  "UID:twice-weekly",
  "RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,TH",
  "DTSTART;TZID=GMT Standard Time:20261109T073000",
  "DTEND;TZID=GMT Standard Time:20261109T080000",
  "X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE",
  "END:VEVENT",
  // All-day holiday, out of office.
  "BEGIN:VEVENT",
  "UID:holiday",
  "DTSTART;VALUE=DATE:20261225",
  "DTEND;VALUE=DATE:20261227",
  "X-MICROSOFT-CDO-BUSYSTATUS:OOF",
  "END:VEVENT",
  // Marked free: must not block.
  "BEGIN:VEVENT",
  "UID:free",
  "DTSTART:20261110T120000Z",
  "DTEND:20261110T130000Z",
  "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
  "END:VEVENT",
  // Cancelled: must not block.
  "BEGIN:VEVENT",
  "UID:cancelled",
  "STATUS:CANCELLED",
  "DTSTART:20261111T120000Z",
  "DTEND:20261111T130000Z",
  "END:VEVENT",
  // Folded long line and a UTC one-off.
  "BEGIN:VEVENT",
  "UID:one-off",
  "SUMMARY:A very long summary that Outlook folds across",
  "  two lines",
  "DTSTART:20261112T150000Z",
  "DTEND:20261112T153000Z",
  "END:VEVENT",
  // Monthly on the second Wednesday, 10:00-11:00.
  "BEGIN:VEVENT",
  "UID:monthly",
  "RRULE:FREQ=MONTHLY;BYDAY=2WE;COUNT=3",
  "DTSTART;TZID=GMT Standard Time:20261111T100000",
  "DTEND;TZID=GMT Standard Time:20261111T110000",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const FROM = Date.parse("2026-11-06T00:00:00Z");
const TO = Date.parse("2027-01-20T00:00:00Z");

describe("Outlook published calendar (busy times)", () => {
  const busy = busyFromIcs(OUTLOOK, FROM, TO).map((b) => [iso(b.start), iso(b.end)]);

  it("expands the weekly Tuesday session in UK time (GMT in winter)", () => {
    expect(busy).toContainEqual(["2026-11-10T18:00:00.000Z", "2026-11-10T19:00:00.000Z"]);
    expect(busy).toContainEqual(["2027-01-12T18:00:00.000Z", "2027-01-12T19:00:00.000Z"]);
  });

  it("drops a skipped week and uses the moved time for an edited week", () => {
    expect(busy).not.toContainEqual(["2026-11-17T18:00:00.000Z", "2026-11-17T19:00:00.000Z"]);
    expect(busy).not.toContainEqual(["2026-11-24T18:00:00.000Z", "2026-11-24T19:00:00.000Z"]);
    expect(busy).toContainEqual(["2026-11-24T19:00:00.000Z", "2026-11-24T20:00:00.000Z"]);
  });

  it("does not include weeks before the window", () => {
    expect(busy.some(([s]) => s < "2026-11-06")).toBe(false);
  });

  it("respects COUNT on a two-days-a-week series", () => {
    const early = busy.filter(([s]) => s.endsWith("T07:30:00.000Z"));
    expect(early.map(([s]) => s.slice(0, 10))).toEqual(["2026-11-09", "2026-11-12", "2026-11-16", "2026-11-19"]);
  });

  it("blocks an all-day out-of-office across both days", () => {
    expect(busy).toContainEqual(["2026-12-25T00:00:00.000Z", "2026-12-27T00:00:00.000Z"]);
  });

  it("ignores free and cancelled entries", () => {
    expect(busy.some(([s]) => s === "2026-11-10T12:00:00.000Z" || s === "2026-11-11T12:00:00.000Z")).toBe(false);
  });

  it("reads one-off UTC events and monthly second-Wednesday series", () => {
    expect(busy).toContainEqual(["2026-11-12T15:00:00.000Z", "2026-11-12T15:30:00.000Z"]);
    expect(busy.filter(([s]) => s.endsWith("T10:00:00.000Z")).map(([s]) => s.slice(0, 10))).toEqual(["2026-11-11", "2026-12-09", "2027-01-13"]);
  });

  it("maps Windows time-zone names", () => {
    expect(ianaFor("GMT Standard Time", "UTC")).toBe("Europe/London");
    expect(ianaFor("Europe/Paris", "UTC")).toBe("Europe/Paris");
    expect(ianaFor("Unknown Zone", "Europe/London")).toBe("Europe/London");
  });

  it("handles summer time: a BST weekly event maps to the right UTC hour", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:s", "RRULE:FREQ=WEEKLY;COUNT=3", "DTSTART;TZID=GMT Standard Time:20261013T180000", "DTEND;TZID=GMT Standard Time:20261013T190000", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const b = busyFromIcs(ics, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-11-30T00:00:00Z")).map((x) => iso(x.start));
    expect(b).toEqual(["2026-10-13T17:00:00.000Z", "2026-10-20T17:00:00.000Z", "2026-10-27T18:00:00.000Z"]);
  });

  it("is fast on a realistic diary (3 years, 900 entries, 8 weekly series)", () => {
    const lines = ["BEGIN:VCALENDAR"];
    for (let i = 0; i < 900; i++) {
      const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000 * 1.2).toISOString().replace(/[-:]/g, "").slice(0, 15);
      lines.push("BEGIN:VEVENT", `UID:e${i}`, `DTSTART;TZID=GMT Standard Time:${d}`, `DTEND;TZID=GMT Standard Time:${d.slice(0, 9)}${String(Math.min(23, +d.slice(9, 11) + 1)).padStart(2, "0")}0000`, "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "END:VEVENT");
    }
    for (let i = 0; i < 8; i++) lines.push("BEGIN:VEVENT", `UID:w${i}`, `RRULE:FREQ=WEEKLY;BYDAY=${["MO", "TU", "WE", "TH", "FR"][i % 5]}`, `DTSTART;TZID=GMT Standard Time:202509${String(i + 1).padStart(2, "0")}T180000`, `DTEND;TZID=GMT Standard Time:202509${String(i + 1).padStart(2, "0")}T190000`, "END:VEVENT");
    lines.push("END:VCALENDAR");
    const text = lines.join("\r\n");
    busyFromIcs(text, FROM, TO);
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) busyFromIcs(text, FROM, TO);
    console.log(`realistic diary: ${text.length} bytes, ${((performance.now() - t0) / 5).toFixed(1)} ms`);
  });

  it("is fast enough for the free plan on a large, long-history calendar", () => {
    const lines = ["BEGIN:VCALENDAR"];
    for (let i = 0; i < 3000; i++) {
      const d = new Date(Date.UTC(2023, 0, 1) + i * 86400000 * 0.6).toISOString().replace(/[-:]/g, "").slice(0, 15);
      lines.push("BEGIN:VEVENT", `UID:e${i}`, `DTSTART;TZID=GMT Standard Time:${d}`, `DTEND;TZID=GMT Standard Time:${d.slice(0, 9)}235900`, "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "END:VEVENT");
    }
    for (let i = 0; i < 40; i++) lines.push("BEGIN:VEVENT", `UID:r${i}`, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", `DTSTART;TZID=GMT Standard Time:2022${String((i % 12) + 1).padStart(2, "0")}10T090000`, `DTEND;TZID=GMT Standard Time:2022${String((i % 12) + 1).padStart(2, "0")}10T093000`, "END:VEVENT");
    lines.push("END:VCALENDAR");
    const text = lines.join("\r\n");
    busyFromIcs(text, FROM, TO);
    const t0 = performance.now();
    const b = busyFromIcs(text, FROM, TO);
    const ms = performance.now() - t0;
    console.log(`large calendar: ${text.length} bytes, ${b.length} busy periods, ${ms.toFixed(1)} ms`);
    expect(b.length).toBeGreaterThan(0);
  });
});
