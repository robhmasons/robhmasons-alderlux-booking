// Google Calendar integration: read busy times and add confirmed bookings to the host's calendar.
// Optional: if the secrets are not set, the system runs on its own bookings only.

import type { Busy } from "./slots";

export interface CalendarEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_CALENDAR_ID?: string; // e.g. "primary"
  DB?: D1Database; // holds the refresh token saved by the "Connect Google" step
}

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const BOOKING_COLOUR = "9"; // Blueberry: bookings made through the booking page

async function refreshToken(env: CalendarEnv): Promise<string | null> {
  if (env.GOOGLE_REFRESH_TOKEN) return env.GOOGLE_REFRESH_TOKEN;
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("google_refresh_token").first<{ value: string }>();
  return row?.value ?? null;
}

/** True when the app details are set and a Google account has been connected (env or saved token). */
export async function googleConnected(env: CalendarEnv): Promise<boolean> {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (await refreshToken(env)));
}

export function googleAuthorizeUrl(env: CalendarEnv, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Exchanges the sign-in code and saves the long-lived refresh token in D1. */
export async function googleExchangeCode(env: CalendarEnv, code: string, redirectUri: string, f: Fetch = fetch, now = Date.now()): Promise<void> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new Error(`Google code exchange failed: ${res.status}`);
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) throw new Error("Google did not return a refresh token");
  await env.DB!.prepare("INSERT INTO settings (key, value, updated_ms) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms").bind("google_refresh_token", j.refresh_token, now).run();
  cached = null;
}

type Fetch = typeof fetch;

export function calendarConfigured(env: CalendarEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

let cached: { token: string; expires: number } | null = null;

export function _resetTokenCache(): void {
  cached = null;
}

async function accessToken(env: CalendarEnv, f: Fetch, now: number): Promise<string> {
  if (cached && cached.expires > now + 60000) return cached.token;
  const rt = await refreshToken(env);
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: rt ?? "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expires: now + j.expires_in * 1000 };
  return j.access_token;
}

export async function googleBusy(env: CalendarEnv, from: number, to: number, f: Fetch = fetch, now = Date.now()): Promise<Busy[]> {
  if (!calendarConfigured(env)) return [];
  const token = await accessToken(env, f, now);
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const res = await f("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: calendarId }] }),
  });
  if (!res.ok) throw new Error(`Google freeBusy failed: ${res.status}`);
  const j = (await res.json()) as { calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
  const cal = j.calendars?.[calendarId];
  if (!cal || cal.errors?.length) throw new Error("Google freeBusy returned an error for the calendar");
  return (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

export async function googleInsertEvent(
  env: CalendarEnv,
  ev: { summary: string; description: string; location: string; start: number; end: number; attendeeEmail: string },
  f: Fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  if (!(await googleConnected(env))) return null;
  const token = await accessToken(env, f, now);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  const res = await f(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=0&sendUpdates=none`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      location: ev.location,
      start: { dateTime: new Date(ev.start).toISOString() },
      end: { dateTime: new Date(ev.end).toISOString() },
      colorId: BOOKING_COLOUR,
      transparency: "opaque",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    }),
  });
  if (!res.ok) throw new Error(`Google event insert failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

export async function googleDeleteEvent(env: CalendarEnv, eventId: string, f: Fetch = fetch, now = Date.now()): Promise<void> {
  if (!(await googleConnected(env))) return;
  const token = await accessToken(env, f, now);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  const res = await f(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 410 && res.status !== 404) throw new Error(`Google event delete failed: ${res.status}`);
}
