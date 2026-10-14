-- Personal instance: the checked singleton slot prevents two simultaneous signups.
CREATE TABLE users (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
  challenge TEXT NOT NULL,
  user_id TEXT,
  name TEXT,
  invite_hash TEXT,
  expires INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges(expires);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires);
CREATE TABLE states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL CHECK(rev > 0),
  wid TEXT NOT NULL,
  chunks INTEGER NOT NULL CHECK(chunks > 0),
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  sha256 TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE state_chunks (
  user_id TEXT NOT NULL REFERENCES states(user_id) ON DELETE CASCADE,
  wid TEXT NOT NULL,
  n INTEGER NOT NULL CHECK(n >= 0),
  data TEXT NOT NULL,
  PRIMARY KEY(user_id, wid, n)
);
