ALTER TABLE cloudflare_connections ADD COLUMN cf_subject TEXT;
ALTER TABLE oauth_sessions ADD COLUMN reconnect_id TEXT;
ALTER TABLE connection_accounts ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS api_leases (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id), expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS api_leases_connection ON api_leases(connection_id,expires_at);
-- Serialize the same upstream DNS target even through different credentials.
ALTER TABLE dns_locks RENAME TO legacy_dns_locks;
CREATE TABLE dns_locks (account_id TEXT NOT NULL, zone_id TEXT NOT NULL, record_key TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL REFERENCES operations(id), PRIMARY KEY(account_id,zone_id,record_key));
INSERT OR IGNORE INTO dns_locks SELECT o.account_id,l.zone_id,l.record_key,l.operation_id FROM legacy_dns_locks l JOIN operations o ON o.id=l.operation_id;
DROP TABLE legacy_dns_locks;
