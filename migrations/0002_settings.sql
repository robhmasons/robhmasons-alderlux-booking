-- Small key-value store for connection state (e.g. the rotating Microsoft refresh token).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
