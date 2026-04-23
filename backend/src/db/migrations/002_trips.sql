CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destinations TEXT NOT NULL DEFAULT '[]',
  destination_countries TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  travellers TEXT NOT NULL DEFAULT 'couple',
  interest_tags TEXT NOT NULL DEFAULT '[]',
  pace TEXT NOT NULL DEFAULT 'moderate',
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trip_collaborators (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
