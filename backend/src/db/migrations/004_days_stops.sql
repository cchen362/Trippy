CREATE TABLE IF NOT EXISTS days (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  city TEXT NOT NULL,
  phase TEXT,
  hotel TEXT,
  theme TEXT,
  color_code TEXT,
  UNIQUE(trip_id, date)
);

CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  day_id TEXT NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  time TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'explore',
  note TEXT,
  lat REAL,
  lng REAL,
  unsplash_photo_url TEXT,
  estimated_cost TEXT,
  booking_required INTEGER DEFAULT 0,
  best_time TEXT,
  duration TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
