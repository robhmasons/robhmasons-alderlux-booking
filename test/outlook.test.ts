import { beforeEach, describe, expect, it } from "vitest";
import { _resetOutlookCache, checkState, exchangeCode, makeState, outlookBusy, outlookDeleteEvent, outlookConnected, outlookCreateEvent, getSetting, setSetting, authorizeUrl } from "../src/outlook";

// Minimal in-memory stand-in for the D1 "settings" table.
function fakeDb() {
  const rows = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first<T>() { return (rows.has(args[0] as string) ? { value: rows.get(args[0] as string) } : null) as T; },
        async run() { if (sql.startsWith("INSERT INTO settings")) rows.set(args[0] as string, args[1] as string); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, rows };
}

type Call = { url: string; method: string; body?: string; headers: Headers };
function fakeMs(handlers: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : init.body?.toString(), headers: new Headers(init.headers) };
    calls.push(c);
    return handlers(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const base = { MS_CLIENT_ID: "cid", MS_CLIENT_SECRET: "sec", ADMIN_KEY: "admin-key-123" };

describe("Outlook connection", () => {
  beforeEach(() => _resetOutlookCache());

  it("is not connected until a refresh token is stored", async () => {
    const { db } = fakeDb();
    expect(await outlookConnected({ ...base, DB: db })).toBe(false);
    await setSetting(db, "ms_refresh_token", "r1");
    expect(await outlookConnected({ ...base, DB: db })).toBe(true);
    expect(await outlookConnected({ DB: db })).toBe(false); // app details missing
  });

  it("signed state is accepted once fresh and rejected when tampered or expired", async () => {
    const env = { ...base, DB: fakeDb().db };
    const s = await makeState(env, 1_000_000);
    expect(await checkState(env, s, 1_000_000 + 60_000)).toBe(true);
    expect(await checkState(env, s.replace(/.$/, "x"), 1_000_000)).toBe(false);
    expect(await checkState(env, s, 1_000_000 + 16 * 60_000)).toBe(false);
    expect(await checkState({ ...env, ADMIN_KEY: "other" }, s, 1_000_000)).toBe(false);
  });

  it("authorize URL asks for offline access, calendar and mail", () => {
    const u = new URL(authorizeUrl({ ...base, DB: fakeDb().db }, "https://book.example/oauth/outlook/callback", "st"));
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(u.searchParams.get("scope")).toContain("Calendars.ReadWrite");
    expect(u.searchParams.get("scope")).not.toContain("Mail"); // Outlook must never be able to send email
  });

  it("exchanging the code stores the refresh token; refresh rotates and stores the new one", async () => {
    const { db } = fakeDb();
    const env = { ...base, DB: db };
    let n = 0;
    const { f } = fakeMs((c) => {
      if (c.url.includes("/token")) { n++; return Response.json({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }); }
      return Response.json({ value: [] });
    });
    await exchangeCode(env, "code", "https://x/cb", f, 0);
    expect(await getSetting(db, "ms_refresh_token")).toBe("r1");
    _resetOutlookCache();
    await outlookBusy(env, 0, 1, f, 10_000_000);
    expect(await getSetting(db, "ms_refresh_token")).toBe("r2");
  });
});

describe("Outlook calendar and mail", () => {
  let env: { MS_CLIENT_ID: string; MS_CLIENT_SECRET: string; ADMIN_KEY: string; DB: D1Database };
  beforeEach(async () => {
    _resetOutlookCache();
    const { db } = fakeDb();
    await setSetting(db, "ms_refresh_token", "r0");
    env = { ...base, DB: db };
  });
  const tok = (c: Call) => (c.url.includes("/token") ? Response.json({ access_token: "a", expires_in: 3600 }) : null);

  it("reads busy times in UTC, follows paging, ignores free and cancelled items", async () => {
    const { f, calls } = fakeMs((c) => tok(c) ?? (c.url.includes("page2")
      ? Response.json({ value: [{ start: { dateTime: "2026-11-20T15:00:00.0000000" }, end: { dateTime: "2026-11-20T16:00:00.0000000" }, showAs: "oof", isCancelled: false }] })
      : Response.json({
          value: [
            { start: { dateTime: "2026-11-20T10:00:00.0000000" }, end: { dateTime: "2026-11-20T11:00:00.0000000" }, showAs: "busy", isCancelled: false },
            { start: { dateTime: "2026-11-20T12:00:00.0000000" }, end: { dateTime: "2026-11-20T13:00:00.0000000" }, showAs: "free", isCancelled: false },
            { start: { dateTime: "2026-11-20T13:00:00.0000000" }, end: { dateTime: "2026-11-20T14:00:00.0000000" }, showAs: "busy", isCancelled: true },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?page2",
        })));
    const busy = await outlookBusy(env, 0, 1, f);
    expect(busy).toEqual([
      { start: Date.parse("2026-11-20T10:00:00Z"), end: Date.parse("2026-11-20T11:00:00Z") },
      { start: Date.parse("2026-11-20T15:00:00Z"), end: Date.parse("2026-11-20T16:00:00Z") },
    ]);
    const view = calls.find((c) => c.url.includes("calendarView"))!;
    expect(view.headers.get("prefer")).toBe('outlook.timezone="UTC"');
    expect(view.headers.get("authorization")).toBe("Bearer a");
  });

  it("fails loudly on a Microsoft error so no false availability is shown", async () => {
    const { f } = fakeMs((c) => tok(c) ?? new Response("nope", { status: 503 }));
    await expect(outlookBusy(env, 0, 1, f)).rejects.toThrow();
  });

  it("adds the call to the calendar with no attendees, so Outlook emails nobody", async () => {
    const { f, calls } = fakeMs((c) => tok(c) ?? Response.json({ id: "EV1" }, { status: 201 }));
    const id = await outlookCreateEvent(env, { subject: "S", bodyText: "details", location: "Zoom", start: Date.parse("2026-11-20T10:00:00Z"), end: Date.parse("2026-11-20T10:45:00Z") }, f);
    expect(id).toBe("EV1");
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/me/events"))!.body!);
    expect(body.start).toEqual({ dateTime: "2026-11-20T10:00:00.000", timeZone: "UTC" });
    expect(body.attendees).toEqual([]);
    expect(calls.some((c) => c.url.includes("sendMail"))).toBe(false);
  });

  it("removes a cancelled call from the calendar", async () => {
    const { f, calls } = fakeMs((c) => tok(c) ?? new Response(null, { status: 204 }));
    await outlookDeleteEvent(env, "EV1", f);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/me/events/EV1"))).toBe(true);
  });
});
