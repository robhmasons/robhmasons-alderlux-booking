// Busy times from Calendly's API. Calendly reads Robert's Outlook calendar live, so a new Outlook
// entry reaches the booking page within minutes (the published .ics link can lag by hours or go stale).
// Needs one Worker secret, CALENDLY_TOKEN (a Calendly personal access token). The result is cached in
// D1 for a few minutes so page loads do not call Calendly every time.

import type { Busy } from "./slots";

export interface CalendlyEnv {
  CALENDLY_TOKEN?: string; // secret: Calendly personal access token (scope availability:read)
  CALENDLY_USER_URI?: string; // not secret: the host's Calendly user URI; looked up via /users/me if unset
}

const API = "https://api.calendly.com";
const CACHE_KEY = "calendly_busy_cache";
const ERROR_KEY = "calendly_last_error";

/** How long a Calendly fetch stays fresh before the next page load fetches again. */
export const CALENDLY_CACHE_TTL_MS = 5 * 60 * 1000;
/** If a refresh fails, a Calendly result up to this old is still preferred to the .ics link (which can be 3 hours old). */
export const CALENDLY_STALE_OK_MS = 30 * 60 * 1000;
/** Days ahead to fetch. Must cover the furthest bookable day (config maxDaysAhead, 60) plus a margin. Same as the .ics path. */
export const BUSY_WINDOW_DAYS = 75;
/** Calendly allows at most 7 days per request. A minute short of that, so a boundary rounding never gets a 400. */
export const CHUNK_MS = 7 * 86400000 - 60000;
/** Requests in flight at once (11 requests per refresh; kept small to respect Calendly's rate limits). */
const PARALLEL = 2;
const REQUEST_TIMEOUT_MS = 8000;

type Fetch = typeof fetch;

interface BusyItem {
  type?: string;
  start_time?: string;
  end_time?: string;
  buffered_start_time?: string | null;
  buffered_end_time?: string | null;
}

function signal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

async function get(f: Fetch, url: string, token: string): Promise<unknown> {
  const res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: signal() });
  // Status only: never echo the response body or the token into logs or the status page.
  if (!res.ok) throw new Error(`Calendly returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("Calendly returned a response that is not JSON");
  }
}

async function userUri(env: CalendlyEnv, f: Fetch): Promise<string> {
  if (env.CALENDLY_USER_URI) return env.CALENDLY_USER_URI;
  const j = (await get(f, `${API}/users/me`, env.CALENDLY_TOKEN!)) as { resource?: { uri?: string } };
  const uri = j?.resource?.uri;
  if (typeof uri !== "string" || !uri.startsWith(API + "/users/")) throw new Error("Calendly /users/me returned no user");
  return uri;
}

function parseTime(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** One Calendly busy entry as a busy period. Uses the buffered times when Calendly gives them. */
export function toBusy(item: BusyItem): Busy {
  const start = parseTime(item.start_time);
  const end = parseTime(item.end_time);
  if (start === null || end === null || end < start) throw new Error("Calendly returned a malformed busy time");
  const bs = parseTime(item.buffered_start_time);
  const be = parseTime(item.buffered_end_time);
  return { start: bs !== null && bs < start ? bs : start, end: be !== null && be > end ? be : end };
}

/** Sorts and joins overlapping or touching periods (an event spanning two requests comes back twice). */
export function mergeBusy(list: Busy[]): Busy[] {
  const sorted = [...list].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: Busy[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/** The request windows: from `start` to `end` in pieces no longer than Calendly allows. */
export function chunks(start: number, end: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let s = start; s < end; s += CHUNK_MS) out.push({ from: s, to: Math.min(s + CHUNK_MS, end) });
  return out;
}

/** All busy periods from shortly after `now` to BUSY_WINDOW_DAYS ahead. Throws on any failure: a partial answer is never used. */
export async function fetchCalendlyBusy(env: CalendlyEnv, now: number, f: Fetch = fetch): Promise<Busy[]> {
  if (!env.CALENDLY_TOKEN) throw new Error("CALENDLY_TOKEN is not set");
  const user = await userUri(env, f);
  // Calendly refuses a start time in the past; a minute ahead allows for clock differences. Slots need
  // 12 hours' notice, so nothing bookable is lost.
  const list = chunks(now + 60000, now + BUSY_WINDOW_DAYS * 86400000);
  const found: Busy[] = [];
  for (let i = 0; i < list.length; i += PARALLEL) {
    const batch = list.slice(i, i + PARALLEL).map(async (c) => {
      const q = new URLSearchParams({ user, start_time: new Date(c.from).toISOString(), end_time: new Date(c.to).toISOString() });
      const j = (await get(f, `${API}/user_busy_times?${q}`, env.CALENDLY_TOKEN!)) as { collection?: unknown };
      if (!j || !Array.isArray(j.collection)) throw new Error("Calendly returned a response without a busy list");
      return (j.collection as BusyItem[]).map(toBusy);
    });
    for (const r of await Promise.all(batch)) found.push(...r);
  }
  return mergeBusy(found);
}

// --- Cache in D1 ------------------------------------------------------------------------------------

export interface CalendlyCache {
  fetched: number;
  busy: Busy[];
}

async function put(db: D1Database, key: string, value: string, now: number): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value, updated_ms) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_ms = ?3").bind(key, value, now).run();
}

/** Fetches from Calendly and stores the result. Returns the number of busy periods. On failure, records the error (no secrets) and rethrows. */
export async function refreshCalendlyBusy(db: D1Database, env: CalendlyEnv, now: number, f: Fetch = fetch): Promise<number> {
  try {
    const busy = await fetchCalendlyBusy(env, now, f);
    await put(db, CACHE_KEY, JSON.stringify({ fetched: now, busy: busy.map((b) => [b.start, b.end]) }), now);
    return busy.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await put(db, ERROR_KEY, JSON.stringify({ at: now, message }), now).catch(() => undefined);
    throw e;
  }
}

/** The stored Calendly result, whatever its age (null if never fetched). */
export async function readCalendlyCache(db: D1Database): Promise<CalendlyCache | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CACHE_KEY).first<{ value: string }>();
  if (!row) return null;
  const j = JSON.parse(row.value) as { fetched: number; busy: [number, number][] };
  return { fetched: j.fetched, busy: j.busy.map(([start, end]) => ({ start, end })) };
}

/** The stored Calendly result if it is younger than the TTL, otherwise null. */
export async function cachedCalendlyBusy(db: D1Database, now: number): Promise<CalendlyCache | null> {
  const c = await readCalendlyCache(db);
  return c && now - c.fetched <= CALENDLY_CACHE_TTL_MS && c.fetched <= now ? c : null;
}

export async function lastCalendlyError(db: D1Database): Promise<{ at: number; message: string } | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(ERROR_KEY).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as { at: number; message: string }) : null;
}
