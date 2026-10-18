# Acceptance and release gate

The implementation is a candidate MVP. Local D1/workerd tests and browser tests use fixtures/mock upstream. They do not establish a working live Cloudflare OAuth client or a registered ChatGPT connector.

| Criterion                                                | Automated coverage                                                                  | Live evidence required                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Google login and MCP OAuth/tool                          | PKCE single-use code, metadata, browser Origin checks, authenticated MCP tools/call | Google consent, ChatGPT authorization and whoami                            |
| Two app users, two Cloudflare identities, three accounts | D1 access-policy fixtures; multi-account tests                                      | Three account IDs, both identities and two simultaneous chats               |
| Same resource names route correctly                      | Explicit target and zone/account mismatch checks                                    | Same-named lab resources in two accounts                                    |
| ID swapping cannot access another user's target          | Authorization, operation actor checks, revoked grants                               | Repeat using two live app logins                                            |
| No shared current account                                | Stateless MCP server per request; explicit target schemas                           | Two concurrent chats and labeled results                                    |
| Revocation applies next request                          | Grant revoke after approval, viewer downgrade                                       | Revoke grant/connection then retry approved operation                       |
| Expiry, refresh concurrency, 429                         | Real D1 refresh claim and mock token endpoint, 429/concurrency tests                | Upstream token rotation and actual rate-limit headers                       |
| Replay cannot create duplicate DNS                       | Concurrent apply, single-use claim, replay, idempotency key                         | Create/update disposable delegated lab record twice with same operation ID  |
| Timeout after committed write                            | Mock upstream commits then throws; readback verifies once                           | Controlled staging fault injection, no duplicate write                      |
| Secret never leaks                                       | Ciphertext connection binding, sanitized API errors, inventory allowlists           | Inspect browser, tool results, audit and configured Worker log sink         |
| DNS verification                                         | API readback success/conflict/uncertainty behavior                                  | API readback plus public DNS resolution after suitable propagation interval |
| Recovery                                                 | Versioned migration/local fixture setup                                             | Staging DB restore and credential/token reconciliation rehearsal            |
| Private/public OAuth                                     | Documentation and no automatic visibility mutation                                  | Confirm identities can authorize intended client; owner decides visibility  |

Release procedure:

1. Complete the read-only integration gate first: Google login → ChatGPT whoami → two accounts → second identity. Record commit, environment, timestamp, redacted request IDs and pass/fail. Keep DNS disabled until this passes.
2. Run two-user isolation checks and sharing/revocation cases. Confirm permissions follow the current database, including operations approved before revocation.
3. Create a DNS preview in a delegated lab zone; inspect exact target and diff in UI, approve there, apply, replay, verify via API and DNS. Repeat for update, expiration, data conflict and injected timeout.
4. Rehearse backup/recovery, configure retention and usage alerts, then decide whether to enable production DNS. Do not publish a public OAuth client or claim Free-tier fit from fixture tests.

**Current live status: NOT RUN.** This execution environment supplied Git access but no Google/Cloudflare application credentials or provisioned staging D1/domain. No real Cloudflare resource was changed.
