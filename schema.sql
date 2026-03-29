-- Groups table
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT,
  context TEXT DEFAULT '',
  focus TEXT DEFAULT '',
  message_count INTEGER DEFAULT 0,
  first_message_date TEXT,
  last_message_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Messages table (stored separately for efficient date filtering)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  parsed_date TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(group_id, parsed_date);

-- Summaries table (keeps history per group)
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  date_from TEXT,
  date_to TEXT,
  message_count INTEGER,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summaries_group ON summaries(group_id);

-- Cross analyses table
CREATE TABLE IF NOT EXISTS cross_analyses (
  id TEXT PRIMARY KEY,
  group_ids TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Settings table (API key etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
