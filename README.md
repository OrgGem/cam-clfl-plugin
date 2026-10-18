# Gem Cloudflare Local

Manage Cloudflare connections/accounts on your device. OAuth tokens stay in the OS credential vault; the local companion calls Cloudflare directly. No vendor-hosted backend, D1, Google login or shared credential database is required.

```text
Local MCP host ──stdio──► companion on your device ──HTTPS──► Cloudflare
                                   │
                      OS vault + local operation journal
                                   │
                     authenticated loopback browser UI
```

**Requires a host that supports local stdio MCP**, such as the documented Codex host. ChatGPT web's remote HTTPS MCP registration does not establish support for a local process. Embedded-only execution remains unverified; see [host capability evidence](docs/HOST-CAPABILITIES.md). This is an implemented local companion, not a claim that ChatGPT web can reach localhost.

## Install and open

Node 22.12+ and npm. On Linux, a running/unlocked desktop Secret Service is required; plaintext and in-memory credential fallbacks are disabled. macOS uses Keychain; Windows uses the OS credential backend through `@napi-rs/keyring`. Platform-specific live vault behavior still needs testing on the user's device.

```sh
npm ci
npm run build
npm start
```

Open the **private launch URL printed in the terminal**. It contains a one-time fragment ticket; the UI removes the fragment and exchanges it for an HttpOnly local session. Do not share that URL. The listener binds only `127.0.0.1:3210`.

1. Create a Cloudflare OAuth client with token authentication `none`, Authorization Code and S256 PKCE. Register exact redirect URI `http://127.0.0.1:3210/oauth/callback` (verify the provider accepts this loopback redirect for your client).
2. Enter its public client ID and approved scope IDs in Connections. Include `openid offline_access` plus permissions for account discovery and the resources you intend to use. No client secret is requested or supported. Select scope IDs from Cloudflare's actual catalog rather than guessing.
3. Add connection, authorize in Cloudflare, inspect the returned identity/accounts and Confirm. Add another connection for another identity. A connection may expose multiple accounts.
4. Set account aliases and lab/production. Use Resources for direct reads and DNS previews; Changes for approval, execution and local history.

Private/public OAuth client _visibility_ is distinct from public-client token authentication. A private-visibility client only accepts members of its owning Cloudflare account. Public visibility/domain verification is an account-owner decision, not an automatic app action.

## Connect ChatGPT in a browser

Use OpenAI Secure MCP Tunnel to forward requests to the companion on your device, subject to account/workspace access. Follow [the ChatGPT web setup](docs/CHATGPT-WEB.md). The repository does not create a tunnel or install a plugin into your account automatically. Cloudflare tokens stay local; tool results still reach ChatGPT.

## Connect a local MCP host

Keep the UI and MCP processes under the same OS user and data directory. Use an absolute checkout path:

```sh
codex mcp add gem-cloudflare-local -- node /ABSOLUTE/REPO/dist/node/apps/local/src/cli.js mcp
```

Alternatively install `plugin/` as a **local-source** plugin in a host that supports stdio. The launcher resolves the built runtime from this checkout, so keep the checkout and its installed dependencies in place. It is not yet a standalone desktop installer or universal ChatGPT web package. Do not configure `npm run mcp` as the transport command: npm's normal banner can corrupt stdio; launch `node` directly.

Tools: `whoami`, `list_connections`, `list_accounts`, `list_zones`, `list_dns_records`, `list_workers`, `list_d1_databases`, `list_tunnels`, `preview_dns_change`, `apply_operation`, `get_operation_status`. There is no tool for uploading credentials or approving operations. Select connection/account explicitly on each resource call.

## Verify

```sh
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
npm run format:check
```

Checks include schema/credential boundaries, mock OAuth discovery for two identities/three accounts, explicit routing, refresh/revoke, browser state/CSRF checks, MCP tools, crash/timeout-safe DNS journal, actual compiled stdio handshake and loopback binary/assets/session smoke. Browser E2E uses an injected fixture vault and fake Cloudflare; production CLI always constructs the OS vault and fixed Cloudflare transport.

**Live OAuth, real OS-vault integration on each platform and real DNS propagation have not been accepted yet.** No real Cloudflare resource has been changed in this implementation session. See [acceptance checklist](docs/ACCEPTANCE.md).

## Data and recovery

Metadata, saved DNS diffs and operation journal live in `~/.gem-cloudflare/state.json`; token values live separately in the OS vault. Override directory with `GEM_DATA_DIR`, and port with `GEM_PORT` (also register its exact OAuth callback). No telemetry, hosted relay or updater is included.

[Security, backups, reconnect and crash recovery](docs/OPERATIONS.md). [Token custody and trust boundaries](docs/SECURITY.md).

The old Workers/D1 server manager is archived under `legacy/server-manager` and branch `archive/server-manager-v0.1`. It is excluded from active builds/tests and is not the local application's installation path. No automatic credential migration from that backend is performed.
