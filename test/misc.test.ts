import { beforeEach, describe, expect, it } from "vitest";
import { validateBooking } from "../src/validate";
import { buildIcs } from "../src/ics";
import { googleBusy, googleInsertEvent, _resetTokenCache } from "../src/calendar";
import { renderEmail } from "../src/email";
import { TENANTS } from "../src/config";

const et = TENANTS.alderlux.eventTypes.find((e) => e.slug === "succession")!;
const good = { type: "succession", start: "2026-11-20T10:00:00.000Z", name: "Jane Smith", email: "Jane@Example.co.uk", answers: { heard_about: "Personal introduction", held_how: "Own wallet" } };

describe("validateBooking", () => {
  it("accepts a valid booking and normalises email", () => {
    const v = validateBooking(good, et);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.email).toBe("jane@example.co.uk");
  });
  it("rejects a filled honeypot", () => expect(validateBooking({ ...good, website: "spam" }, et).ok).toBe(false));
  it("rejects a missing required answer", () => expect(validateBooking({ ...good, answers: {} }, et).ok).toBe(false));
  it("rejects an option that is not on the list", () => expect(validateBooking({ ...good, answers: { heard_about: "Bribe" } }, et).ok).toBe(false));
  it("rejects a bad email and a bad time", () => {
    expect(validateBooking({ ...good, email: "nope" }, et).ok).toBe(false);
    expect(validateBooking({ ...good, start: "soon" }, et).ok).toBe(false);
  });
  it("drops answers to questions that do not exist", () => {
    const v = validateBooking({ ...good, answers: { ...good.answers, injected: "x" } }, et);
    expect(v.ok && "injected" in v.value.answers).toBe(false);
  });
});

describe("buildIcs", () => {
  it("produces a valid single event with CRLF line endings and escaped text", () => {
    const ics = buildIcs({ uid: "a@b", start: Date.parse("2026-11-20T10:00:00Z"), end: Date.parse("2026-11-20T10:45:00Z"), summary: "Call, with; Alderlux", description: "Line1\nLine2", location: "Zoom", organizerEmail: "anna@alderlux.com", now: Date.parse("2026-11-06T00:00:00Z") });
    expect(ics).toContain("DTSTART:20261120T100000Z\r\n");
    expect(ics).toContain("SUMMARY:Call\\, with\\; Alderlux");
    expect(ics).toContain("DESCRIPTION:Line1\\nLine2");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});

describe("Google Calendar adapter", () => {
  beforeEach(() => _resetTokenCache());
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", GOOGLE_CALENDAR_ID: "primary" };

  it("returns no busy times when not configured, without any network call", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await googleBusy({}, 0, 1, f)).toEqual([]);
    expect(called).toBe(false);
  });

  it("refreshes a token once and parses busy periods", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json({ calendars: { primary: { busy: [{ start: "2026-11-20T10:00:00Z", end: "2026-11-20T11:00:00Z" }] } } });
    }) as unknown as typeof fetch;
    const b1 = await googleBusy(env, 0, 1, f, 1000);
    await googleBusy(env, 0, 1, f, 2000);
    expect(b1).toEqual([{ start: Date.parse("2026-11-20T10:00:00Z"), end: Date.parse("2026-11-20T11:00:00Z") }]);
    expect(calls.filter((u) => u.includes("oauth2"))).toHaveLength(1);
  });

  it("fails loudly if Google reports a calendar error, so no false availability is shown", async () => {
    const f = (async (url: string) => url.includes("oauth2") ? Response.json({ access_token: "t", expires_in: 3600 }) : Response.json({ calendars: { primary: { errors: [{ reason: "notFound" }] } } })) as unknown as typeof fetch;
    await expect(googleBusy(env, 0, 1, f)).rejects.toThrow();
  });

  it("inserts an event and returns its id", async () => {
    const f = (async (url: string) => url.includes("oauth2") ? Response.json({ access_token: "t", expires_in: 3600 }) : Response.json({ id: "evt123" })) as unknown as typeof fetch;
    expect(await googleInsertEvent(env, { summary: "s", description: "d", location: "l", start: 0, end: 1, attendeeEmail: "a@b.co" }, f)).toBe("evt123");
  });
});

describe("renderEmail", () => {
  it("escapes user input and includes the footer and postal address", () => {
    const { html, text } = renderEmail({ headline: "New booking", paragraphs: ["<script>x</script>"], footer: TENANTS.alderlux.footer });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('bgcolor="#EFEAE0"');
    expect(text).toContain("Alderlux is not authorised by the Financial Conduct Authority.");
    expect(text).toContain("Alderlux, Bollington Road, Bollington, United Kingdom");
  });
});

describe("mailing list opt-in", () => {
  it("is off unless the box was ticked", async () => {
    const { validateBooking } = await import("../src/validate");
    const { getTenant } = await import("../src/config");
    const t = getTenant("alderlux")!;
    const et = t.eventTypes[0];
    const base = { type: et.slug, start: "2026-11-20T10:00:00Z", name: "Test Person", email: "t@example.com", answers: { heard_about: "Other" } };
    const a = validateBooking(base, et);
    const b = validateBooking({ ...base, subscribe: true }, et);
    const c = validateBooking({ ...base, subscribe: "yes" }, et);
    expect(a.ok && a.value.subscribe).toBe(false);
    expect(b.ok && b.value.subscribe).toBe(true);
    expect(c.ok && c.value.subscribe).toBe(false);
    expect(t.mailingList?.label).toContain("Send me free updates");
  });
});
