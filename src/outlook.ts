// Microsoft Outlook (Microsoft Graph) integration, free with any Outlook.com or Microsoft 365 account.
// Calendar only: reads busy times, adds bookings to Robert's calendar and removes cancelled ones.
// It never emails anyone: events are created without attendees, and the app has no mail permission.
// Booking emails are sent from admin@alderlux.com (see smtp.ts).
//
// Keeping it working: Microsoft rotates refresh tokens, so every refresh stores the newest one in D1.
// Reminders run every 30 minutes, which keeps the connection in regular use. If the connection is ever
// revoked (password change, removed app consent), the booking page shows "temporarily unavailable" and
// Robert reconnects once at /oauth/outlook/start?key=ADMIN_KEY.

import type { Busy } from "./slots";

export interface OutlookEnv {
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  MS_AUTHORITY?: string; // "common" (default) or "consumers" for Outlook.com only
  ADMIN_KEY?: string;
  DB: D1Database;
}

type Fetch = typeof fetch;
const GRAPH = "https://graph.microsoft.com/v1.0";
export const OUTLOOK_SCOPES = "offline_access openid User.Read Calendars.ReadWrite";
const REFRESH_KEY = "ms_refresh_token";

export function outlookAppConfigured(env: OutlookEnv): boolean {
  return Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

function authority(env: OutlookEnv): string {
  return `https://login.microsoftonline.com/${env.MS_AUTHORITY || "common"}/oauth2/v2.0`;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string, now = Date.now()): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value, updated_ms) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_ms = ?3").bind(key, value, now).run();
}

/** True when the app is set up AND Robert has connected his mailbox. */
export async function outlookConnected(env: OutlookEnv): Promise<boolean> {
  return outlookAppConfigured(env) && (await getSetting(env.DB, REFRESH_KEY)) !== null;
}

// --- OAuth: signed state so the callback can't be forged -------------------------------------------

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeState(env: OutlookEnv, now = Date.now()): Promise<string> {
  const ts = String(now);
  return `${ts}.${await hmac(env.ADMIN_KEY!, ts)}`;
}

export async function checkState(env: OutlookEnv, state: string, now = Date.now()): Promise<boolean> {
  const [ts, sig] = state.split(".");
  if (!ts || !sig || !env.ADMIN_KEY) return false;
  if (now - Number(ts) > 15 * 60000 || Number(ts) > now + 60000) return false; // 15-minute window
  return safeEqual(sig, await hmac(env.ADMIN_KEY, ts));
}

export function authorizeUrl(env: OutlookEnv, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.MS_CLIENT_ID!, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: OUTLOOK_SCOPES, state, prompt: "select_account" });
  return `${authority(env)}/authorize?${q}`;
}

async function tokenRequest(env: OutlookEnv, params: Record<string, string>, f: Fetch): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await f(`${authority(env)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, scope: OUTLOOK_SCOPES, ...params }),
  });
  if (!res.ok) throw new Error(`Microsoft token request failed: ${res.status}`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

let cached: { token: string; expires: number } | null = null;
export function _resetOutlookCache(): void {
  cached = null;
}

export async function exchangeCode(env: OutlookEnv, code: string, redirectUri: string, f: Fetch = fetch, now = Date.now()): Promise<void> {
  const t = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f);
  if (!t.refresh_token) throw new Error("Microsoft did not return a refresh token (is offline_access granted?)");
  await setSetting(env.DB, REFRESH_KEY, t.refresh_token, now);
  cached = { token: t.access_token, expires: now + t.expires_in * 1000 };
}

async function accessToken(env: OutlookEnv, f: Fetch, now: number): Promise<string> {
  if (cached && cached.expires > now + 60000) return cached.token;
  const refresh = await getSetting(env.DB, REFRESH_KEY);
  if (!refresh) throw new Error("Outlook is not connected");
  const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh }, f);
  if (t.refresh_token && t.refresh_token !== refresh) await setSetting(env.DB, REFRESH_KEY, t.refresh_token, now);
  cached = { token: t.access_token, expires: now + t.expires_in * 1000 };
  return t.access_token;
}

async function graph(env: OutlookEnv, f: Fetch, now: number, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env, f, now);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return f(path.startsWith("http") ? path : `${GRAPH}${path}`, { ...init, headers });
}

// --- Calendar and mail ------------------------------------------------------------------------------

const BLOCKING = new Set(["busy", "tentative", "oof", "workingElsewhere"]);

export async function outlookBusy(env: OutlookEnv, from: number, to: number, f: Fetch = fetch, now = Date.now()): Promise<Busy[]> {
  const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $select: "start,end,showAs,isCancelled", $top: "200" });
  let url: string | null = `${GRAPH}/me/calendarView?${q}`;
  const out: Busy[] = [];
  for (let page = 0; url && page < 10; page++) {
    const res = await graph(env, f, now, url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    if (!res.ok) throw new Error(`Outlook calendarView failed: ${res.status}`);
    const j = (await res.json()) as { value: { start: { dateTime: string }; end: { dateTime: string }; showAs: string; isCancelled: boolean }[]; "@odata.nextLink"?: string };
    for (const e of j.value) {
      if (e.isCancelled || !BLOCKING.has(e.showAs)) continue;
      out.push({ start: Date.parse(e.start.dateTime.replace(/Z?$/, "Z")), end: Date.parse(e.end.dateTime.replace(/Z?$/, "Z")) });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  return out;
}

export async function outlookCreateEvent(
  env: OutlookEnv,
  ev: { subject: string; bodyText: string; location: string; start: number; end: number },
  f: Fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const utc = (ms: number) => ({ dateTime: new Date(ms).toISOString().replace("Z", ""), timeZone: "UTC" });
  const res = await graph(env, f, now, "/me/events", {
    method: "POST",
    body: JSON.stringify({
      subject: ev.subject,
      body: { contentType: "Text", content: ev.bodyText },
      start: utc(ev.start),
      end: utc(ev.end),
      location: { displayName: ev.location },
      attendees: [], // deliberately none: Outlook must not email the client
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
    }),
  });
  if (!res.ok) throw new Error(`Outlook event create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Removes a cancelled booking from Robert's calendar. No attendees, so nobody is emailed. */
export async function outlookDeleteEvent(env: OutlookEnv, eventId: string, f: Fetch = fetch, now = Date.now()): Promise<void> {
  const res = await graph(env, f, now, `/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Outlook event delete failed: ${res.status}`);
}
