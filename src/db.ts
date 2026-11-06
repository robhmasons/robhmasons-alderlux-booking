import type { Busy } from "./slots";

export interface BookingRow {
  id: string;
  tenant: string;
  event_type: string;
  start_ms: number;
  end_ms: number;
  name: string;
  email: string;
  answers: string;
  heard_about: string | null;
  status: "confirmed" | "cancelled";
  cancel_token: string;
  calendar_event_id: string | null;
  reminder_sent: number;
  created_ms: number;
  cancelled_ms: number | null;
}

export async function bookedBusy(db: D1Database, tenant: string, from: number, to: number): Promise<Busy[]> {
  const res = await db
    .prepare("SELECT start_ms, end_ms FROM bookings WHERE tenant = ? AND status = 'confirmed' AND start_ms < ? AND end_ms > ?")
    .bind(tenant, to, from)
    .all<{ start_ms: number; end_ms: number }>();
  return (res.results ?? []).map((r) => ({ start: r.start_ms, end: r.end_ms }));
}

/**
 * Insert only if no confirmed booking overlaps (including the buffer). A single statement,
 * so two people choosing the same slot at the same moment cannot both succeed.
 */
export async function insertIfFree(db: D1Database, row: Omit<BookingRow, "status" | "calendar_event_id" | "reminder_sent" | "cancelled_ms">, bufferMin: number): Promise<boolean> {
  const pad = bufferMin * 60000;
  const res = await db
    .prepare(
      `INSERT INTO bookings (id, tenant, event_type, start_ms, end_ms, name, email, answers, heard_about, cancel_token, created_ms)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings WHERE tenant = ?2 AND status = 'confirmed' AND start_ms < ?5 + ?12 AND end_ms + ?12 > ?4
       )`,
    )
    .bind(row.id, row.tenant, row.event_type, row.start_ms, row.end_ms, row.name, row.email, row.answers, row.heard_about, row.cancel_token, row.created_ms, pad)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function byToken(db: D1Database, token: string): Promise<BookingRow | null> {
  return (await db.prepare("SELECT * FROM bookings WHERE cancel_token = ?").bind(token).first<BookingRow>()) ?? null;
}

export async function cancelByToken(db: D1Database, token: string, now: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE bookings SET status = 'cancelled', cancelled_ms = ? WHERE cancel_token = ? AND status = 'confirmed'")
    .bind(now, token)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function setCalendarEventId(db: D1Database, id: string, eventId: string): Promise<void> {
  await db.prepare("UPDATE bookings SET calendar_event_id = ? WHERE id = ?").bind(eventId, id).run();
}

export async function dueReminders(db: D1Database, now: number, windowMs: number): Promise<BookingRow[]> {
  const res = await db
    .prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent = 0 AND start_ms > ? AND start_ms <= ?")
    .bind(now, now + windowMs)
    .all<BookingRow>();
  return res.results ?? [];
}

export async function markReminded(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE bookings SET reminder_sent = 1 WHERE id = ?").bind(id).run();
}
