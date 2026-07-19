-- Plan 19 Wave 1: trip expenses (shared spending diary with owed amounts).
-- Money is stored as INTEGER minor units (cents/yen — never REAL) per currency.
-- expenses is the first and only monetary source of truth; a booking cost is an
-- expense row with booking_id set. Bookings never gain a price column.
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  payer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  note TEXT,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  summary_amount INTEGER,
  summary_currency TEXT,
  fx_rate REAL,
  fx_rate_date TEXT,
  fx_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expenses_trip_date
  ON expenses(trip_id, expense_date);

CREATE TABLE IF NOT EXISTS expense_owed (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_expense_owed_expense
  ON expense_owed(expense_id);

CREATE TABLE IF NOT EXISTS fx_rates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  rate REAL NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(base_currency, quote_currency, rate_date)
);

ALTER TABLE trips ADD COLUMN summary_currency TEXT;
