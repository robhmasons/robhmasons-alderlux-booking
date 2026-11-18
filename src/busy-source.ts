// Chooses where Robert's busy times come from: Calendly first (live), then the published Outlook .ics
// link (cached for up to 3 hours). If a configured source cannot be read, never guess: the caller
// shows "temporarily unavailable" instead of offering times that may clash.

import type { Busy } from "./slots";
import { cachedCalendlyBusy, refreshCalendlyBusy, type CalendlyEnv } from "./calendly-busy";
import { cachedIcsBusy, refreshIcsBusy } from "./ics-busy";

export interface BusySourceEnv extends CalendlyEnv {
  DB: D1Database;
  OUTLOOK_ICS_URL?: string;
}

export type BusySource = "calendly" | "ics";

export interface BusyResult {
  source: BusySource;
  fetched: number; // when that source was last fetched (UTC ms)
  busy: Busy[];
}

/** Thrown when a busy source is configured but none could be read. */
export class CalendarUnavailable extends Error {}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Busy periods from the configured sources, in order of preference. Returns null when neither
 * Calendly nor the .ics link is configured (the caller then uses a connected Outlook/Google account).
 */
export async function publishedBusy(env: BusySourceEnv, now: number, f: typeof fetch = fetch): Promise<BusyResult | null> {
  if (!env.CALENDLY_TOKEN && !env.OUTLOOK_ICS_URL) return null;
  if (env.CALENDLY_TOKEN) {
    let cache = await cachedCalendlyBusy(env.DB, now);
    if (!cache) {
      try {
        await refreshCalendlyBusy(env.DB, env, now, f);
        cache = await cachedCalendlyBusy(env.DB, now);
      } catch (e) {
        console.error("Calendly busy times failed, using the calendar link instead: " + msg(e));
      }
    }
    if (cache) return { source: "calendly", ...cache };
  }
  if (env.OUTLOOK_ICS_URL) {
    let cache = await cachedIcsBusy(env.DB, now);
    if (!cache) {
      try {
        await refreshIcsBusy(env.DB, env.OUTLOOK_ICS_URL, now, f);
        cache = await cachedIcsBusy(env.DB, now);
      } catch (e) {
        console.error("calendar link refresh failed: " + msg(e));
      }
    }
    if (cache) return { source: "ics", ...cache };
  }
  throw new CalendarUnavailable("no busy source could be read");
}

/** Cron: keep both caches warm (Calendly for page loads, the .ics cache as the fallback). */
export async function refreshAllBusy(env: BusySourceEnv, now: number, f: typeof fetch = fetch): Promise<void> {
  if (env.CALENDLY_TOKEN) await refreshCalendlyBusy(env.DB, env, now, f).catch((e) => console.error("Calendly busy refresh failed: " + msg(e)));
  if (env.OUTLOOK_ICS_URL) await refreshIcsBusy(env.DB, env.OUTLOOK_ICS_URL, now, f).catch((e) => console.error("calendar link refresh failed: " + msg(e)));
}
