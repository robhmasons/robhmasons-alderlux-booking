import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_WINDOW_DAYS, CALENDLY_CACHE_TTL_MS, CHUNK_MS, cachedCalendlyBusy, chunks, fetchCalendlyBusy, lastCalendlyError, mergeBusy, refreshCalendlyBusy, toBusy } from "../src/calendly-busy";
import { CalendarUnavailable, publishedBusy, refreshAllBusy } from "../src/busy-source";
import worker, { handleCalendarStatus, type Env } from "../src/worker";
import { TENANTS } from "../src/config";

const NOW = Date.parse("2026-11-18T12:00:00Z"); // Wednesday
const DAY = 86400000;
const TOKEN = "test-token-not-real";
const USER = "https://api.calendly.com/users/test-user";
const ICS_URL = "https://outlook.example/calendar.ics";
const iso = (ms: number) => new Date(ms).toISOString();

// In-memory stand-in for D1: the "settings" table plus an empty "bookings" table.
function fakeDb() {
  const rows = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first<T>() { return (rows.has(args[0] as string) ? { value: rows.get(args[0] as string) } : null) as T; },
        async run() { if (sql.startsWith("INSERT INTO settings")) rows.set(args[0] as string, args[1] as string); return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, rows };
}

type Item = { type: string; start_time: string; end_time: string; buffered_start_time?: string | null; buffered_end_time?: string | null };
interface Call { url: URL; headers: Headers }

/** Fake network: Calendly returns the items overlapping each requested range; the .ics link returns `ics`. */
function fakeNet(opts: { items?: Item[]; ics?: string; calendly?: (c: Call, n: number) => Response | Promise<Response> | undefined } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const c = { url, headers: new Headers(init.headers) };
    calls.push(c);
    if (url.hostname === "api.calendly.com") {
      const custom = opts.calendly?.(c, n++);
      if (custom) return custom;
      if (url.pathname === "/users/me") return Response.json({ resource: { uri: USER } });
      const from = Date.parse(url.searchParams.get("start_time")!);
      const to = Date.parse(url.searchParams.get("end_time")!);
      const collection = (opts.items ?? []).filter((i) => Date.parse(i.start_time) < to && Date.parse(i.end_time) > from);
      return Response.json({ collection });
    }
    if (input === ICS_URL) {
      if (opts.ics === undefined) return new Response("gone", { status: 404 });
      return new Response(opts.ics, { headers: { "content-type": "text/calendar" } });
    }
    throw new Error("unexpected fetch " + input);
  }) as unknown as typeof fetch;
  return { f, calls, calendlyCalls: () => calls.filter((c) => c.url.pathname === "/user_busy_times") };
}

const ICS_EMPTY = ["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join("\r\n");

describe("Calendly busy times: requests", () => {
  it("covers the booking window in chunks of at most 7 days, never starting in the past", async () => {
    const net = fakeNet();
    await fetchCalendlyBusy({ CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER }, NOW, net.f);
    const cs = net.calendlyCalls();
    expect(cs.length).toBe(Math.ceil((BUSY_WINDOW_DAYS * DAY - 60000) / CHUNK_MS)); // 11
    let prevEnd: number | null = null;
    for (const c of cs) {
      const s = Date.parse(c.url.searchParams.get("start_time")!);
      const e = Date.parse(c.url.searchParams.get("end_time")!);
      expect(s).toBeGreaterThan(NOW);
      expect(e - s).toBeLessThanOrEqual(7 * DAY);
      expect(e).toBeGreaterThan(s);
      if (prevEnd !== null) expect(s).toBe(prevEnd); // no gaps between chunks
      prevEnd = e;
      expect(c.url.searchParams.get("user")).toBe(USER);
      expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(prevEnd).toBe(NOW + BUSY_WINDOW_DAYS * DAY);
  });

  it("the window reaches past the furthest bookable day", () => {
    expect(BUSY_WINDOW_DAYS).toBeGreaterThanOrEqual(TENANTS.alderlux.rules.maxDaysAhead + 2);
  });

  it("splits ranges exactly", () => {
    expect(chunks(0, 3 * CHUNK_MS + 5)).toEqual([{ from: 0, to: CHUNK_MS }, { from: CHUNK_MS, to: 2 * CHUNK_MS }, { from: 2 * CHUNK_MS, to: 3 * CHUNK_MS }, { from: 3 * CHUNK_MS, to: 3 * CHUNK_MS + 5 }]);
  });

  it("looks the user up once via /users/me when no user URI is configured", async () => {
    const net = fakeNet();
    await fetchCalendlyBusy({ CALENDLY_TOKEN: TOKEN }, NOW, net.f);
    expect(net.calls.filter((c) => c.url.pathname === "/users/me").length).toBe(1);
    expect(net.calendlyCalls().every((c) => c.url.searchParams.get("user") === USER)).toBe(true);
  });
});

describe("Calendly busy times: parsing", () => {
  it("uses buffered times when present and plain times when they are null", () => {
    expect(toBusy({ type: "calendly", start_time: "2026-11-23T10:00:00Z", end_time: "2026-11-23T11:00:00Z", buffered_start_time: "2026-11-23T09:45:00Z", buffered_end_time: "2026-11-23T11:15:00Z" })).toEqual({ start: Date.parse("2026-11-23T09:45:00Z"), end: Date.parse("2026-11-23T11:15:00Z") });
    expect(toBusy({ type: "external", start_time: "2026-11-23T10:00:00Z", end_time: "2026-11-23T11:00:00Z", buffered_start_time: null, buffered_end_time: null })).toEqual({ start: Date.parse("2026-11-23T10:00:00Z"), end: Date.parse("2026-11-23T11:00:00Z") });
  });

  it("rejects malformed entries", () => {
    expect(() => toBusy({ start_time: "nonsense", end_time: "2026-11-23T11:00:00Z" })).toThrow();
    expect(() => toBusy({ start_time: "2026-11-23T11:00:00Z" })).toThrow();
    expect(() => toBusy({ start_time: "2026-11-23T11:00:00Z", end_time: "2026-11-23T10:00:00Z" })).toThrow();
  });

  it("joins an event returned by two neighbouring chunks into one period", async () => {
    // Spans the first chunk boundary, so both requests return it.
    const boundary = NOW + 60000 + CHUNK_MS;
    const net = fakeNet({ items: [{ type: "external", start_time: iso(boundary - 3600000), end_time: iso(boundary + 3600000) }] });
    const busy = await fetchCalendlyBusy({ CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER }, NOW, net.f);
    expect(busy).toEqual([{ start: boundary - 3600000, end: boundary + 3600000 }]);
    expect(mergeBusy([{ start: 5, end: 10 }, { start: 1, end: 3 }, { start: 8, end: 12 }])).toEqual([{ start: 1, end: 3 }, { start: 5, end: 12 }]);
  });
});

describe("Calendly busy times: cache", () => {
  const env = () => ({ DB: fakeDb().db, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER, OUTLOOK_ICS_URL: ICS_URL });

  it("is reused for 5 minutes, then fetched again", async () => {
    expect(CALENDLY_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    const e = env();
    const net = fakeNet({ items: [{ type: "external", start_time: "2026-11-23T09:00:00Z", end_time: "2026-11-23T10:00:00Z" }], ics: ICS_EMPTY });
    const a = await publishedBusy(e, NOW, net.f);
    expect(a?.source).toBe("calendly");
    expect(a?.busy).toEqual([{ start: Date.parse("2026-11-23T09:00:00Z"), end: Date.parse("2026-11-23T10:00:00Z") }]);
    const after1 = net.calendlyCalls().length;
    await publishedBusy(e, NOW + CALENDLY_CACHE_TTL_MS, net.f);
    expect(net.calendlyCalls().length).toBe(after1); // still fresh
    const c = await publishedBusy(e, NOW + CALENDLY_CACHE_TTL_MS + 1, net.f);
    expect(net.calendlyCalls().length).toBe(2 * after1); // refetched
    expect(c?.fetched).toBe(NOW + CALENDLY_CACHE_TTL_MS + 1);
    expect(net.calls.some((x) => x.url.href === ICS_URL)).toBe(false); // .ics not needed while Calendly works
  });

  it("an expired cache is not served", async () => {
    const { db } = fakeDb();
    await refreshCalendlyBusy(db, { CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER }, NOW, fakeNet().f);
    expect(await cachedCalendlyBusy(db, NOW + CALENDLY_CACHE_TTL_MS)).not.toBeNull();
    expect(await cachedCalendlyBusy(db, NOW + CALENDLY_CACHE_TTL_MS + 1)).toBeNull();
  });
});

describe("Calendly busy times: fallback to the calendar link", () => {
  const ICS_ONE = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART:20261124T120000Z", "DTEND:20261124T130000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const failures: [string, (c: Call, n: number) => Response | Promise<Response> | undefined, string][] = [
    ["401", () => new Response("{}", { status: 401 }), "Calendly returned 401"],
    ["429", () => new Response("{}", { status: 429 }), "Calendly returned 429"],
    ["500", () => new Response("{}", { status: 500 }), "Calendly returned 500"],
    ["network error", () => Promise.reject(new TypeError("fetch failed")), "fetch failed"],
    ["not JSON", () => new Response("<html>", { status: 200 }), "not JSON"],
    ["no collection", () => Response.json({ data: [] }), "without a busy list"],
    ["bad times", () => Response.json({ collection: [{ type: "external", start_time: "soon", end_time: "later" }] }), "malformed"],
    ["one chunk fails mid-way", (_c, n) => (n === 4 ? new Response("{}", { status: 503 }) : undefined), "Calendly returned 503"],
  ];
  for (const [name, calendly, expected] of failures) {
    it(`uses the .ics link when Calendly fails (${name}) and records why`, async () => {
      const { db } = fakeDb();
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const r = await publishedBusy({ DB: db, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER, OUTLOOK_ICS_URL: ICS_URL }, NOW, fakeNet({ ics: ICS_ONE, calendly }).f);
      expect(r?.source).toBe("ics");
      expect(r?.busy).toEqual([{ start: Date.parse("2026-11-24T12:00:00Z"), end: Date.parse("2026-11-24T13:00:00Z") }]);
      expect(err.mock.calls.flat().join(" ")).toContain(expected);
      expect((await lastCalendlyError(db))?.message).toContain(expected);
      expect(await cachedCalendlyBusy(db, NOW)).toBeNull(); // a partial result is never stored
      err.mockRestore();
    });
  }

  it("throws (page shows 'temporarily unavailable') when both sources fail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const net = fakeNet({ calendly: () => new Response("{}", { status: 500 }) }); // .ics link returns 404
    await expect(publishedBusy({ DB: fakeDb().db, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER, OUTLOOK_ICS_URL: ICS_URL }, NOW, net.f)).rejects.toBeInstanceOf(CalendarUnavailable);
    err.mockRestore();
  });

  it("throws when Calendly fails and no .ics link is set (does not fall through to an unconnected calendar)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const net = fakeNet({ calendly: () => new Response("{}", { status: 401 }) });
    await expect(publishedBusy({ DB: fakeDb().db, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER }, NOW, net.f)).rejects.toBeInstanceOf(CalendarUnavailable);
    err.mockRestore();
  });

  it("without CALENDLY_TOKEN, behaves exactly as before (calendar link only, no Calendly calls)", async () => {
    const net = fakeNet({ ics: ICS_ONE });
    const r = await publishedBusy({ DB: fakeDb().db, OUTLOOK_ICS_URL: ICS_URL }, NOW, net.f);
    expect(r?.source).toBe("ics");
    expect(net.calls.some((c) => c.url.hostname === "api.calendly.com")).toBe(false);
    expect(await publishedBusy({ DB: fakeDb().db }, NOW, net.f)).toBeNull();
  });

  it("the scheduled job refreshes both caches", async () => {
    const { db, rows } = fakeDb();
    await refreshAllBusy({ DB: db, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER, OUTLOOK_ICS_URL: ICS_URL }, NOW, fakeNet({ ics: ICS_ONE }).f);
    expect(rows.has("calendly_busy_cache")).toBe(true);
    expect(rows.has("ics_busy_cache")).toBe(true);
  });
});

// --- Through the Worker -----------------------------------------------------------------------------

describe("Worker with Calendly", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Robert's recurring Monday client sessions, as Calendly reports them from Outlook (UK time = UTC in November).
  const MONDAY_SESSIONS: Item[] = [
    { type: "external", start_time: "2026-11-23T09:00:00Z", end_time: "2026-11-23T10:00:00Z", buffered_start_time: null, buffered_end_time: null },
    { type: "external", start_time: "2026-11-23T20:00:00Z", end_time: "2026-11-23T21:00:00Z", buffered_start_time: null, buffered_end_time: null },
  ];

  async function mondaySlots(env: Partial<Env>, net: ReturnType<typeof fakeNet>): Promise<string[]> {
    vi.stubGlobal("fetch", net.f);
    const res = await worker.fetch(new Request("https://book.example/api/slots?type=the-edge&from=2026-11-23&days=1"), { DB: fakeDb().db, ...env } as Env);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { slots: Record<string, string[]> };
    return j.slots["2026-11-23"] ?? [];
  }

  it("regression 17/11: the stale .ics link misses the Monday sessions, Calendly has them, so 09:00 and 20:00 are not offered", async () => {
    const net = fakeNet({ items: MONDAY_SESSIONS, ics: ICS_EMPTY });
    // Before: calendar link only. The stale link has no Monday sessions, so the clashing times were offered.
    const before = await mondaySlots({ OUTLOOK_ICS_URL: ICS_URL }, net);
    expect(before).toContain("2026-11-23T09:00:00.000Z");
    expect(before).toContain("2026-11-23T20:00:00.000Z");
    // After: Calendly first.
    const after = await mondaySlots({ OUTLOOK_ICS_URL: ICS_URL, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER }, net);
    expect(after).not.toContain("2026-11-23T09:00:00.000Z");
    expect(after).not.toContain("2026-11-23T20:00:00.000Z");
    // The 30-minute buffer still applies around each session; other times on the day stay open.
    expect(after).not.toContain("2026-11-23T10:00:00.000Z");
    expect(after).not.toContain("2026-11-23T08:00:00.000Z");
    expect(after).toContain("2026-11-23T10:30:00.000Z");
    expect(after).toContain("2026-11-23T07:30:00.000Z");
    expect(after).toContain("2026-11-23T21:30:00.000Z");
  });

  it("shows 'temporarily unavailable' (503) when Calendly and the .ics link both fail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fakeNet({ calendly: () => new Response("{}", { status: 500 }) }).f);
    const res = await worker.fetch(new Request("https://book.example/api/slots?type=the-edge&from=2026-11-23&days=1"), { DB: fakeDb().db, OUTLOOK_ICS_URL: ICS_URL, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER } as Env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Availability is temporarily unavailable. Please try again shortly.");
    err.mockRestore();
  });

  it("calendar-status reports the source, fetch time and count, without secrets", async () => {
    const env = { DB: fakeDb().db, ADMIN_KEY: "admin-key-123", OUTLOOK_ICS_URL: ICS_URL, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER } as Env;
    const net = fakeNet({ items: MONDAY_SESSIONS, ics: ICS_EMPTY });
    expect((await handleCalendarStatus(new URL("https://b/admin/calendar-status?key=wrong"), env, NOW, net.f)).status).toBe(403);
    const res = await handleCalendarStatus(new URL("https://b/admin/calendar-status?key=admin-key-123"), env, NOW, net.f);
    const text = await res.text();
    const j = JSON.parse(text);
    expect(j.source).toBe("calendly");
    expect(j.busyPeriods).toBe(2);
    expect(j.calendly).toMatchObject({ status: "ok", fetched: iso(NOW), busyPeriods: 2, cacheMinutes: 5 });
    expect(j.calendarLink).toMatchObject({ status: "ok", fetched: iso(NOW), busyPeriods: 0 });
    expect(j.next10).toHaveLength(2);
    for (const secret of [TOKEN, ICS_URL, "admin-key-123"]) expect(text).not.toContain(secret);
  });

  it("calendar-status shows the fallback and Calendly's error when Calendly fails", async () => {
    const env = { DB: fakeDb().db, ADMIN_KEY: "admin-key-123", OUTLOOK_ICS_URL: ICS_URL, CALENDLY_TOKEN: TOKEN, CALENDLY_USER_URI: USER } as Env;
    const net = fakeNet({ ics: ICS_EMPTY, calendly: () => new Response("{}", { status: 401 }) });
    const text = await (await handleCalendarStatus(new URL("https://b/admin/calendar-status?key=admin-key-123"), env, NOW, net.f)).text();
    const j = JSON.parse(text);
    expect(j.source).toBe("ics");
    expect(j.calendly.status).toBe("error");
    expect(j.calendly.error).toBe("Calendly returned 401");
    expect(j.calendly.lastError.message).toBe("Calendly returned 401");
    expect(text).not.toContain(TOKEN);
  });
});
