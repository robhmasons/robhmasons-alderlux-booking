-- Bookings. One host per tenant for now; overlap is prevented by the insert statement in src/db.ts.
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  event_type TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  heard_about TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  cancel_token TEXT NOT NULL UNIQUE,
  calendar_event_id TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  cancelled_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bookings_tenant_start ON bookings (tenant, status, start_ms);
CREATE INDEX IF NOT EXISTS idx_bookings_reminder ON bookings (status, reminder_sent, start_ms);
