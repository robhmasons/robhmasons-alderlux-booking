import { getTenant, type EventType, type Tenant } from "./config";
import { availableSlots, isBookable, type Busy } from "./slots";
import { addDays, isIsoDate, localDate, localParts } from "./time";
import { validateBooking } from "./validate";
import { type BookingRow, bookedBusy, byToken, cancelByToken, dueReminders, insertIfFree, markReminded, setCalendarEventId } from "./db";
import { googleBusy, googleDeleteEvent, googleInsertEvent, type CalendarEnv } from "./calendar";
import { connect } from "cloudflare:sockets";
import { renderEmail, sendEmail, type EmailBinding, type Message } from "./email";
import type { SmtpConfig } from "./smtp";
import { STATIC } from "./static.generated";
import { authorizeUrl, checkState, exchangeCode, makeState, outlookAppConfigured, outlookBusy, outlookConnected, outlookCreateEvent, outlookDeleteEvent, safeEqual, type OutlookEnv } from "./outlook";
import { buildFeed, buildIcs } from "./ics";
import { cachedIcsBusy, refreshIcsBusy } from "./ics-busy";

export interface Env extends CalendarEnv, OutlookEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  EMAIL?: EmailBinding;
  TENANT?: string; // default tenant slug
  // Outgoing mail from admin@alderlux.com via the domain's mail server (Namecheap Private Email).
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: "on" | "starttls" | "off";
  SMTP_USER?: string;
  SMTP_PASS?: string; // secret
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  OUTLOOK_ICS_URL?: string; // secret: Outlook "Publish calendar" .ics link (busy times only)
  PUBLIC_BASE_URL?: string; // overrides the tenant's public address (e.g. the workers.dev URL)
}

function tenantFor(slug: string, env: Env): Tenant | undefined {
  const t = getTenant(slug);
  return t && env.PUBLIC_BASE_URL ? { ...t, publicBaseUrl: env.PUBLIC_BASE_URL } : t;
}

function smtpConfig(env: Env, tenant: Tenant): SmtpConfig | undefined {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return undefined;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE || "on",
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || tenant.fromEmail,
    fromName: env.MAIL_FROM_NAME || tenant.name,
  };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** Send from admin@alderlux.com (SMTP); otherwise Cloudflare Email Service if bound; otherwise log (dev). */
async function mail(env: Env, tenant: Tenant, msg: Message): Promise<void> {
  return sendEmail({ smtp: smtpConfig(env, tenant), connect: connect as never, binding: env.EMAIL, from: tenant.fromEmail }, msg);
}

function errText(e: unknown): string {
  const t = (e as { transcript?: string[] })?.transcript;
  return (e instanceof Error ? e.message : String(e)) + (t ? " | " + t.slice(-6).join(" / ") : "");
}

function token(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function whenText(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(ms));
}

const UNAVAILABLE = () => new Response(JSON.stringify({ error: "Availability is temporarily unavailable. Please try again shortly." }), { status: 503, headers: JSON_HEADERS });

/** Busy periods from Robert's calendar: the published Outlook link (cached), or a connected calendar. */
async function calendarBusy(env: Env, from: number, to: number): Promise<Busy[]> {
  if (env.OUTLOOK_ICS_URL) {
    const now = Date.now();
    let cache = await cachedIcsBusy(env.DB, now);
    if (!cache) {
      try {
        await refreshIcsBusy(env.DB, env.OUTLOOK_ICS_URL, now);
        cache = await cachedIcsBusy(env.DB, now);
      } catch (e) {
        console.error("calendar link refresh failed: " + errText(e));
      }
    }
    if (!cache) throw UNAVAILABLE(); // never offer times we can't check
    return cache.busy.filter((b) => b.start < to && b.end > from);
  }
  try {
    return (await outlookConnected(env)) ? await outlookBusy(env, from, to) : await googleBusy(env, from, to);
  } catch (e) {
    console.error("calendar busy lookup failed: " + errText(e));
    throw UNAVAILABLE();
  }
}

/** All busy periods for a window: confirmed bookings plus Robert's calendar. */
async function busyFor(env: Env, tenant: Tenant, from: number, to: number): Promise<Busy[]> {
  const [own, cal] = await Promise.all([bookedBusy(env.DB, tenant.slug, from, to), calendarBusy(env, from, to)]);
  return [...own, ...cal];
}

function windowFor(fromDate: string, days: number): { from: number; to: number } {
  // Generous UTC window around the local dates (covers any UK offset).
  return { from: Date.parse(fromDate + "T00:00:00Z") - 36e5 * 14, to: Date.parse(addDays(fromDate, days) + "T00:00:00Z") + 36e5 * 14 };
}

async function handleSlots(url: URL, env: Env, tenant: Tenant, now: number): Promise<Response> {
  const et = tenant.eventTypes.find((e) => e.slug === url.searchParams.get("type"));
  if (!et) return json({ error: "Unknown meeting type." }, 404);
  const tz = tenant.availability.timezone;
  const today = localDate(now, tz);
  const fromParam = url.searchParams.get("from");
  const fromDate = isIsoDate(fromParam) && fromParam > today ? fromParam : today;
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 31);
  const w = windowFor(fromDate, days);
  const busy = await busyFor(env, tenant, w.from, w.to);
  const slots = availableSlots({ fromDate, days, now, todayLocal: today, availability: tenant.availability, rules: { ...tenant.rules, durationMin: et.durationMin }, busy });
  const out: Record<string, string[]> = {};
  for (const [d, list] of Object.entries(slots)) out[d] = list.map((s) => new Date(s).toISOString());
  return json({ timezone: tz, type: et.slug, durationMin: et.durationMin, from: fromDate, days, lastBookableDate: addDays(today, tenant.rules.maxDaysAhead), slots: out });
}

function bookingSummary(et: EventType, start: number, tz: string): string {
  return `${et.name}\n${whenText(start, tz)}\n${et.location}`;
}

async function handleBook(req: Request, env: Env, tenant: Tenant, now: number): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const et = tenant.eventTypes.find((e) => e.slug === (body as { type?: string })?.type);
  const v = validateBooking(body, et);
  if (!v.ok) return json({ error: v.error }, 400);
  const eventType = et!;
  const tz = tenant.availability.timezone;
  const startMs = v.value.startMs;
  const endMs = startMs + eventType.durationMin * 60000;
  const startLocalDate = localDate(startMs, tz);
  const w = windowFor(startLocalDate, 1);
  const busy = await busyFor(env, tenant, w.from, w.to);
  const rules = { ...tenant.rules, durationMin: eventType.durationMin };
  if (!isBookable(startMs, { now, todayLocal: localDate(now, tz), availability: tenant.availability, rules, busy, startLocalDate })) {
    return json({ error: "Sorry, that time is no longer available. Please choose another." }, 409);
  }
  const id = crypto.randomUUID();
  const cancelToken = token();
  const ok = await insertIfFree(
    env.DB,
    { id, tenant: tenant.slug, event_type: eventType.slug, start_ms: startMs, end_ms: endMs, name: v.value.name, email: v.value.email, answers: JSON.stringify(v.value.answers), heard_about: v.value.answers.heard_about ?? null, cancel_token: cancelToken, created_ms: now },
    tenant.rules.bufferMin,
  );
  if (!ok) return json({ error: "Sorry, that time has just been taken. Please choose another." }, 409);

  const manageUrl = `${tenant.publicBaseUrl}/manage.html?t=${encodeURIComponent(cancelToken)}`;
  const answersText = eventType.questions.filter((q) => v.value.answers[q.id]).map((q) => `${q.label} ${v.value.answers[q.id]}`);

  // Side effects after the booking is safely stored. A failure here never loses the booking.
  const useOutlook = await outlookConnected(env);
  const detailLines = [`Booked via the ${tenant.name} booking page`, `Name: ${v.value.name}`, `Email: ${v.value.email}`, ...answersText];
  const tasks: Promise<unknown>[] = [];
  if (useOutlook) {
    // Adds the call to Robert's Outlook calendar only. No attendees, so Outlook emails nobody.
    tasks.push(
      outlookCreateEvent(env, { subject: `${eventType.name}: ${v.value.name}`, bodyText: [...detailLines, "", `Manage: ${manageUrl}`].join("\n"), location: eventType.location, start: startMs, end: endMs })
        .then((eid) => setCalendarEventId(env.DB, id, eid))
        .catch((e) => console.error("outlook event failed", e)),
    );
  } else {
    tasks.push(
      googleInsertEvent(env, { summary: `${eventType.name}: ${v.value.name}`, description: detailLines.join("\n"), location: eventType.location, start: startMs, end: endMs, attendeeEmail: v.value.email })
        .then((eid) => (eid ? setCalendarEventId(env.DB, id, eid) : undefined))
        .catch((e) => console.error("calendar insert failed", e)),
    );
  }
  const icsUid = `${id}@${new URL(tenant.publicBaseUrl).host}`;
  const ics = buildIcs({ uid: icsUid, start: startMs, end: endMs, summary: `${eventType.name} with ${tenant.name}`, description: `${eventType.description}\n\nManage your booking: ${manageUrl}`, location: eventType.location, organizerEmail: tenant.fromEmail });
  const client = renderEmail({
    headline: "Your call is confirmed",
    paragraphs: [`Dear ${v.value.name},`, `Thank you for booking. ${bookingSummary(eventType, startMs, tz).replace(/\n/g, ". ")}.`, "If you need to change or cancel, use the link below. You can also add the call to your calendar from there."],
    button: { label: "Manage your booking", url: manageUrl },
    footer: tenant.footer,
  });
  const host = renderEmail({ headline: "New booking", paragraphs: [`${v.value.name} (${v.value.email}) booked ${eventType.name}.`, whenText(startMs, tz), ...answersText], footer: tenant.footer });
  // One mail-server login at a time: some hosts refuse simultaneous logins to the same mailbox.
  tasks.push(
    (async () => {
      await mail(env, tenant, { to: v.value.email, subject: `Confirmed: ${eventType.name}, ${whenText(startMs, tz)}`, ...client, attachments: [{ filename: "alderlux-call.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: ics }] }).catch((e) => console.error("client email failed: " + errText(e)));
      const hostIcs = buildIcs({ uid: icsUid, start: startMs, end: endMs, summary: `${eventType.name}: ${v.value.name}`, description: [...detailLines, "", `Manage: ${manageUrl}`].join("\n"), location: eventType.location, organizerEmail: tenant.fromEmail });
      await mail(env, tenant, { to: tenant.hostEmail, subject: `New booking: ${v.value.name}, ${whenText(startMs, tz)}`, ...host, attachments: [{ filename: "booking.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: hostIcs }] }).catch((e) => console.error("host email failed: " + errText(e)));
    })(),
  );
  await Promise.all(tasks);

  return json({ id, type: eventType.slug, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), manageUrl, manageToken: cancelToken }, 201);
}

async function handleManage(tokenValue: string, env: Env, tenant: Tenant): Promise<Response> {
  const b = await byToken(env.DB, tokenValue);
  if (!b || b.tenant !== tenant.slug) return json({ error: "Booking not found." }, 404);
  const et = tenant.eventTypes.find((e) => e.slug === b.event_type);
  return json({ type: b.event_type, name: et?.name ?? b.event_type, start: new Date(b.start_ms).toISOString(), end: new Date(b.end_ms).toISOString(), status: b.status, location: et?.location ?? "", timezone: tenant.availability.timezone });
}

async function handleIcs(tokenValue: string, env: Env, tenant: Tenant): Promise<Response> {
  const b = await byToken(env.DB, tokenValue);
  if (!b || b.tenant !== tenant.slug) return new Response("Not found", { status: 404 });
  const et = tenant.eventTypes.find((e) => e.slug === b.event_type);
  const ics = buildIcs({ uid: `${b.id}@${new URL(tenant.publicBaseUrl).host}`, start: b.start_ms, end: b.end_ms, summary: `${et?.name ?? "Call"} with ${tenant.name}`, description: et?.description ?? "", location: et?.location ?? "", organizerEmail: tenant.fromEmail, status: b.status === "cancelled" ? "CANCELLED" : "CONFIRMED" });
  return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="alderlux-call.ics"`, "cache-control": "no-store" } });
}

async function handleCancel(tokenValue: string, env: Env, tenant: Tenant, now: number): Promise<Response> {
  const b = await byToken(env.DB, tokenValue);
  if (!b || b.tenant !== tenant.slug) return json({ error: "Booking not found." }, 404);
  if (b.status === "cancelled") return json({ status: "cancelled" });
  if (b.start_ms <= now) return json({ error: "This call has already started or passed." }, 409);
  await cancelByToken(env.DB, tokenValue, now);
  const et = tenant.eventTypes.find((e) => e.slug === b.event_type);
  const tz = tenant.availability.timezone;
  const tasks: Promise<unknown>[] = [];
  if (b.calendar_event_id) {
    const del = (await outlookConnected(env)) ? outlookDeleteEvent(env, b.calendar_event_id) : googleDeleteEvent(env, b.calendar_event_id);
    tasks.push(del.catch((e) => console.error("calendar cancel failed", e)));
  }
  const host = renderEmail({ headline: "Booking cancelled", paragraphs: [`${b.name} (${b.email}) cancelled ${et?.name ?? b.event_type}.`, whenText(b.start_ms, tz)], footer: tenant.footer });
  const client = renderEmail({ headline: "Your call is cancelled", paragraphs: [`Dear ${b.name},`, `Your ${et?.name ?? "call"} on ${whenText(b.start_ms, tz)} has been cancelled. You are welcome to book another time.`], button: { label: "Book another time", url: tenant.publicBaseUrl }, footer: tenant.footer });
  const cancelIcs = buildIcs({ uid: `${b.id}@${new URL(tenant.publicBaseUrl).host}`, start: b.start_ms, end: b.end_ms, summary: `${et?.name ?? "Call"} with ${tenant.name}`, description: "Cancelled", location: et?.location ?? "", organizerEmail: tenant.fromEmail, status: "CANCELLED" });
  tasks.push(
    (async () => {
      await mail(env, tenant, { to: b.email, subject: `Cancelled: ${et?.name ?? "your call"}`, ...client, attachments: [{ filename: "alderlux-call-cancelled.ics", contentType: "text/calendar; charset=utf-8; method=CANCEL", content: cancelIcs }] }).catch((e) => console.error("client email failed: " + errText(e)));
      await mail(env, tenant, { to: tenant.hostEmail, subject: `Cancelled: ${b.name}, ${whenText(b.start_ms, tz)}`, ...host, attachments: [{ filename: "booking-cancelled.ics", contentType: "text/calendar; charset=utf-8; method=CANCEL", content: cancelIcs }] }).catch((e) => console.error("host email failed: " + errText(e)));
    })(),
  );
  await Promise.all(tasks);
  return json({ status: "cancelled" });
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' https://api.fontshare.com; font-src https://cdn.fontshare.com https://api.fontshare.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://alderlux.com https://www.alderlux.com https://alderlux-19fc8e.webflow.io; base-uri 'self'; form-action 'self'",
};

/** Serves the embedded booking pages (API deployments without the assets binding). */
function serveStatic(url: URL): Response {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const f = STATIC[path];
  if (!f) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  return new Response(f.body, { headers: { "content-type": f.type, "cache-control": "public, max-age=300", ...SECURITY_HEADERS } });
}

function page(title: string, text: string, status = 200): Response {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><body style="font-family:system-ui;background:#0B0B0D;color:#D8D1C3;padding:32px"><h1 style="color:#F7F4EE;font-weight:400">${esc(title)}</h1><p>${esc(text)}</p></body>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Private feed of confirmed bookings for Robert's Outlook ("Add calendar" > "Subscribe from web"). */
async function handleFeed(url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY || !safeEqual(url.searchParams.get("key") ?? "", env.ADMIN_KEY)) return new Response("Not allowed", { status: 403 });
  const tenant = tenantFor(env.TENANT ?? "alderlux", env)!;
  const rows = await env.DB.prepare("SELECT * FROM bookings WHERE tenant = ? AND status = 'confirmed' AND end_ms > ? ORDER BY start_ms").bind(tenant.slug, Date.now() - 30 * 86400000).all<BookingRow>();
  const host = new URL(tenant.publicBaseUrl).host;
  const events = (rows.results ?? []).map((b) => {
    const et = tenant.eventTypes.find((e) => e.slug === b.event_type);
    const answers = JSON.parse(b.answers || "{}") as Record<string, string>;
    const lines = [`Email: ${b.email}`, ...(et?.questions ?? []).filter((q) => answers[q.id]).map((q) => `${q.label} ${answers[q.id]}`)];
    return { uid: `${b.id}@${host}`, start: b.start_ms, end: b.end_ms, summary: `${et?.name ?? b.event_type}: ${b.name}`, description: lines.join("\n"), location: et?.location ?? "" };
  });
  return new Response(buildFeed(`${tenant.name} bookings`, events), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
}

async function handleCalendarStatus(url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY || !safeEqual(url.searchParams.get("key") ?? "", env.ADMIN_KEY)) return json({ error: "Not allowed." }, 403);
  if (!env.OUTLOOK_ICS_URL) return json({ calendarLink: "not set" });
  const now = Date.now();
  try {
    const count = await refreshIcsBusy(env.DB, env.OUTLOOK_ICS_URL, now);
    const cache = await cachedIcsBusy(env.DB, now);
    const next = (cache?.busy ?? []).filter((b) => b.end > now).slice(0, 10).map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() }));
    return json({ calendarLink: "ok", busyPeriodsNext75Days: count, next10: next });
  } catch (e) {
    return json({ calendarLink: "error", error: errText(e) });
  }
}

/** Sends one test email to the host address and shows the mail server conversation (password redacted). */
async function handleTestEmail(url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY || !safeEqual(url.searchParams.get("key") ?? "", env.ADMIN_KEY)) return json({ error: "Not allowed." }, 403);
  const tenant = tenantFor(env.TENANT ?? "alderlux", env)!;
  const msg = renderEmail({ headline: "Test email", paragraphs: ["This is a test from the Alderlux booking system. No action needed."], footer: tenant.footer });
  try {
    await mail(env, tenant, { to: tenant.hostEmail, subject: "Alderlux booking system: test email", ...msg });
    return json({ ok: true, sentTo: tenant.hostEmail });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e), transcript: (e as { transcript?: string[] }).transcript ?? [] });
  }
}

/** One-time connection of Robert's Outlook mailbox. Protected by ADMIN_KEY and a signed, time-limited state. */
async function handleOutlookOAuth(url: URL, env: Env): Promise<Response> {
  if (!outlookAppConfigured(env) || !env.ADMIN_KEY) return page("Outlook not set up", "The Microsoft app details have not been added yet.", 503);
  const redirectUri = `${url.origin}/oauth/outlook/callback`;
  if (url.pathname === "/oauth/outlook/start") {
    if (!safeEqual(url.searchParams.get("key") ?? "", env.ADMIN_KEY)) return page("Not allowed", "Wrong or missing key.", 403);
    return Response.redirect(authorizeUrl(env, redirectUri, await makeState(env)), 302);
  }
  if (url.pathname === "/oauth/outlook/status") {
    if (!safeEqual(url.searchParams.get("key") ?? "", env.ADMIN_KEY)) return page("Not allowed", "Wrong or missing key.", 403);
    return page("Outlook connection", (await outlookConnected(env)) ? "Connected." : "Not connected.");
  }
  if (url.pathname === "/oauth/outlook/callback") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (!(await checkState(env, state)) || !code) return page("Connection failed", "The link expired or was not valid. Start again.", 400);
    try {
      await exchangeCode(env, code, redirectUri);
    } catch (e) {
      console.error("outlook connect failed", e);
      return page("Connection failed", "Microsoft did not accept the connection. Start again.", 502);
    }
    return page("Outlook connected", "Bookings will now check your Outlook calendar for busy times and add each call to it. Outlook does not email anyone. You can close this page.");
  }
  return page("Not found", "", 404);
}

export async function runReminders(env: Env, now: number): Promise<number> {
  const due = await dueReminders(env.DB, now, 24 * 3600 * 1000);
  let sent = 0;
  for (const b of due) {
    const tenant = tenantFor(b.tenant, env);
    if (!tenant) continue;
    const et = tenant.eventTypes.find((e) => e.slug === b.event_type);
    const tz = tenant.availability.timezone;
    const msg = renderEmail({ headline: "A reminder of your call", paragraphs: [`Dear ${b.name},`, `This is a reminder of your ${et?.name ?? "call"} on ${whenText(b.start_ms, tz)}.`, et?.location ?? ""], button: { label: "Manage your booking", url: `${tenant.publicBaseUrl}/manage.html?t=${encodeURIComponent(b.cancel_token)}` }, footer: tenant.footer });
    try {
      await mail(env, tenant, { to: b.email, subject: `Reminder: ${et?.name ?? "your call"}, ${whenText(b.start_ms, tz)}`, ...msg });
      await markReminded(env.DB, b.id);
      sent++;
    } catch (e) {
      console.error("reminder failed " + b.id + ": " + errText(e));
    }
  }
  return sent;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const tenant = tenantFor(url.searchParams.get("tenant") ?? env.TENANT ?? "alderlux", env);
    if (url.pathname.startsWith("/oauth/outlook/")) return handleOutlookOAuth(url, env);
    if (url.pathname === "/admin/test-email") return handleTestEmail(url, env);
    if (url.pathname === "/admin/calendar-status") return handleCalendarStatus(url, env);
    if (url.pathname === "/calendar.ics") return handleFeed(url, env);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : serveStatic(url);
    if (!tenant) return json({ error: "Unknown business." }, 404);
    const now = Date.now();
    try {
      if (req.method === "GET" && url.pathname === "/api/config") {
        return json({ name: tenant.name, timezone: tenant.availability.timezone, footer: tenant.footer, eventTypes: tenant.eventTypes.map(({ slug, name, description, durationMin, location, questions }) => ({ slug, name, description, durationMin, location, questions })) });
      }
      if (req.method === "GET" && url.pathname === "/api/slots") return await handleSlots(url, env, tenant, now);
      if (req.method === "POST" && url.pathname === "/api/bookings") return await handleBook(req, env, tenant, now);
      const m = url.pathname.match(/^\/api\/bookings\/([A-Za-z0-9_-]{20,64})(\/cancel|\.ics)?$/);
      if (m) {
        if (req.method === "GET" && !m[2]) return await handleManage(m[1], env, tenant);
        if (req.method === "GET" && m[2] === ".ics") return await handleIcs(m[1], env, tenant);
        if (req.method === "POST" && m[2] === "/cancel") return await handleCancel(m[1], env, tenant, now);
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("unhandled", e);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.OUTLOOK_ICS_URL) await refreshIcsBusy(env.DB, env.OUTLOOK_ICS_URL, Date.now()).catch((e) => console.error("calendar link refresh failed: " + errText(e)));
    await runReminders(env, Date.now());
  },
} satisfies ExportedHandler<Env>;

// Exported for tests.
export const _internal = { localParts };
