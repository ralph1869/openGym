-- Opt-in only. No existing account, credentials or training state is rewritten.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL,
  scope TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE oauth_consents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sv INTEGER NOT NULL, challenge TEXT NOT NULL, request TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id), redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
  sv INTEGER NOT NULL, expires INTEGER NOT NULL, consumed TEXT
);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id), scope TEXT NOT NULL,
  resource TEXT NOT NULL, sv INTEGER NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX oauth_grants_owner ON oauth_grants(user_id);
CREATE TABLE oauth_access (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE oauth_refresh (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL, consumed TEXT
);
CREATE TABLE mcp_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(user_id,key_hash)
);
