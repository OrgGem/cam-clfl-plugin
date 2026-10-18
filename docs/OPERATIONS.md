# Local operations

## Credential storage

The production CLI uses `SystemVault` only: macOS Keychain, Windows credential backend or Linux Secret Service via `@napi-rs/keyring`. Linux explicitly pins `secret-service`, so the dependency's automatic volatile keyutils fallback is disabled. If the vault is locked/missing, unlock/configure it and retry; credentials are never written to a fallback file.

The keyring service namespace is derived from the absolute data directory; entry IDs are connection UUIDs. Run UI and MCP as the same OS user with the same `GEM_DATA_DIR`. Changing directory does not move credentials. There is no master key to upload and no app login.

The loopback browser sees connection metadata, authorized resource data and diffs, not OAuth access/refresh tokens. Credential-bearing requests are made by the Node companion directly to fixed Cloudflare HTTPS hosts. The browser talks only to loopback. This is client-side custody on the user's device, not a hosted proxy.

## OAuth setup and reconnect

Register a Cloudflare OAuth public client: token authentication `none`, authorization code, S256 PKCE and exact loopback callback. Obtain read/write scope IDs from Cloudflare's catalog, plus OIDC/refresh scopes needed for userinfo and a refresh token. Availability of loopback redirects and authorization by two different identities must be verified on the real client before release. No client secret is embedded in the application.

Config is local and contains only client ID/scopes. An active connection prevents changing client ID until connections are revoked. Browser-bound OAuth state/verifier live only in the companion's memory for ten minutes; restarting the companion invalidates incomplete flows. Discovery is capped at 100 pages of 50 accounts. New/reconnected credentials require identity/account confirmation before use. Reconnect must have exactly the same Cloudflare subject; aliases for still-accessible accounts are retained, missing accounts are removed from the usable target list.

Refresh occurs under the cross-process metadata lock. The journal checkpoints `refreshing` before calling the token endpoint. If refresh fails, use reconnect. A process crash during refresh may already have rotated the token, so `refreshing` after restart is not automatically retried. There is no fallback to another connection.

Revoke persists local `revoked` status first, attempts upstream revocation and deletes the vault entry. If upstream revocation is unconfirmed, revoke in Cloudflare dashboard too. If vault deletion fails because it is locked, local resource access remains disabled; unlock and retry revoke to remove the credential.

## Local UI and MCP

`npm start` prints a one-time launch fragment on stderr and binds only `127.0.0.1`. Keep this private; after bootstrap the browser uses an HttpOnly SameSite=Strict session for eight hours. OAuth has a separate Lax state cookie so the external provider can return to loopback. The local API checks Host, exact Origin for mutations and a 64 KiB body limit. No CORS access or public `/mcp` endpoint is enabled.

The stdio process exposes resource tools but not connection management, credential input or approval. Local stdio assumes the invoking process belongs to the trusted OS user. A same-user malicious process is outside this boundary, as it could also edit metadata or access the user's vault.

Use `node /absolute/path/dist/node/apps/local/src/cli.js mcp` in the host, not npm's normal stdout-producing wrapper. Starting the companion UI does not expose local tools to ChatGPT web. A host supporting local stdio is required; no cloud tunnel is installed.

## DNS journal and recovery

Preview stores immutable target/payload/before-state plus a ten-minute approval deadline and idempotency UUID. Approval is only available in the authenticated local UI. Production requires the exact connection/account/zone string. Changing environment or upstream data invalidates the operation. DNS update uses PATCH to preserve unapproved comment/tag metadata.

An exclusive local file lock serializes refresh and writes across companion/MCP processes. Atomic metadata replacement plus file/directory fsync (where supported) persists write intent before the network call. `applying` and `uncertain` operations only read/reconcile on replay; they never repeat mutation. An unresolved operation blocks another write to the same account/zone/name/type, including via another connection.

A stopped process may leave `state.lock`. Close all UI/MCP instances, ensure the recorded process is stopped, then run exactly one recovery command:

```sh
node dist/node/apps/local/src/cli.js recover-lock
```

Recovery refuses an active or unknown lock owner. It does not reset operation states. Restart and reconcile using the same operation ID. Never edit `applying` back to `approved` or create another write merely because the old result is uncertain. Cloudflare cannot atomically transact the local check and an external client's write, so external edits can still race.

API readback is separate from DNS propagation. Check authoritative/public resolution after appropriate TTL and consider proxy/delegation behavior; there is no universal propagation delay.

## Backup and retention

Stop companion and MCP before backing up the local directory. The state file contains DNS data/diffs and journal history and is owner-readable on POSIX; use a private directory with user-only ACLs on Windows. Back up credentials through the operating system's supported secure mechanism, not a token JSON export. Avoid network-synced data directories; the lock protocol assumes one local filesystem.

Restoring an old journal can resurrect approved or completed operations. Before reopening, revoke/reconnect credentials and retain/mark all unexecuted restored operations for investigation; compare upstream state before any new preview. Do not restore a journal and blindly apply old approvals. Preserve uncertain write entries until reconciled. No automatic retention scheduler is included; future compaction must preserve idempotency keys and unresolved operations.

For support, share sanitized action/request IDs, never the launch URL, browser cookie, OAuth callback URL, token, vault contents or complete DNS TXT payloads.

## Explicit cloud deployment

If the owner explicitly accepts cloud credential custody, the CLI supports `GEM_CREDENTIAL_STORE=encrypted-file`. Set `GEM_DATA_DIR` to a private persistent cloud directory and supply `GEM_VAULT_KEY` as a 32-byte base64/base64url AES key through a runtime secret. The default remains the OS vault; missing/invalid cloud keys fail closed. UI/MCP metadata report cloud custody rather than claiming device-only storage.

This mode encrypts each credential with AES-256-GCM, a fresh IV and authenticated binding to its connection ID and vault directory. Metadata/journal remain separate. Keep the key outside the credential directory and outside Git. A private mode-0600 key file outside the vault can be used when explicitly operating a single-user cloud workspace; it is not a managed HSM, and a compromise/snapshot of the entire host may expose both key and ciphertext. Back up the master key separately: losing it requires reconnecting the Cloudflare identities. No automatic key rotation is implemented.

OpenAI's tunnel runtime API key is distinct from this application-generated encryption key. It must be issued by OpenAI for a principal with tunnel Read + Use; random generation cannot create a valid OpenAI credential. Reference it through `env:CONTROL_PLANE_API_KEY`, never embed it in a profile or repository. Session cloud environments are not an uptime or durable-storage guarantee; configure persistent hosting/supervision before relying on continuous access.

The admin UI still binds loopback. A cloud host needs a protected operator access path and an OAuth redirect that actually reaches that host before real connection management is usable. A local readiness check or empty MCP account list does not establish browser access, Cloudflare OAuth or a successful ChatGPT tool call.
