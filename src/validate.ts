import type { EventType } from "./config";

export interface BookingInput {
  type: string;
  start: string; // ISO instant
  name: string;
  email: string;
  answers: Record<string, string>;
  website?: string; // honeypot: must be empty
  subscribe: boolean; // opted in to the mailing list (unticked by default)
  member?: boolean; // members-only types: the booker ticked "I am an existing Alderlux member"
}

export type Validated = { ok: true; value: BookingInput & { startMs: number } } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

export function validateBooking(body: unknown, eventType: EventType | undefined): Validated {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const b = body as Record<string, unknown>;
  if (typeof b.website === "string" && b.website.trim() !== "") return { ok: false, error: "Invalid request." };
  if (!eventType) return { ok: false, error: "Unknown meeting type." };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (name.length < 2 || name.length > 120) return { ok: false, error: "Please enter your name." };
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "Please enter a valid email address." };
  const startMs = typeof b.start === "string" ? Date.parse(b.start) : NaN;
  if (Number.isNaN(startMs)) return { ok: false, error: "Please choose a time." };
  if (eventType.clientOnly && b.member !== true) return { ok: false, error: "Please confirm you are an existing Alderlux member." };
  const raw = (b.answers && typeof b.answers === "object" ? b.answers : {}) as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const q of eventType.questions) {
    const v = typeof raw[q.id] === "string" ? (raw[q.id] as string).trim() : "";
    if (q.required && !v) return { ok: false, error: `Please answer: ${q.label}` };
    if (v.length > 2000) return { ok: false, error: `Answer too long: ${q.label}` };
    if (v && q.type === "select" && q.options && !q.options.includes(v)) return { ok: false, error: `Please choose an option for: ${q.label}` };
    if (v) answers[q.id] = v;
  }
  return { ok: true, value: { type: eventType.slug, start: new Date(startMs).toISOString(), startMs, name, email, answers, subscribe: b.subscribe === true, member: b.member === true } };
}
