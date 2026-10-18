# Client execution gate — 2026-10-18

The embedded ChatGPT UI is not a verified credential vault or general-purpose local MCP runtime. OpenAI's [UI documentation](https://developers.openai.com/apps-sdk/build/chatgpt-ui) explicitly discourages localStorage for core state because iframe storage is not reliable across sessions/devices. A successful browser fetch alone would not prove safe refresh-token custody or that the model can invoke client functions.

[Codex MCP documentation](https://developers.openai.com/codex/mcp) documents local stdio MCP servers. Therefore this implementation selects a local companion with stdio MCP and an authenticated loopback browser UI. Credential-bearing Cloudflare calls originate from the companion on the user's device. No cloud relay is included.

This does **not** establish ChatGPT web compatibility. A host must support starting a local stdio MCP process. Registering a remote HTTPS connector does not make localhost reachable from ChatGPT's servers. ChatGPT embedded-UI-only mode remains unproven, not silently replaced by a hosted credential proxy.

Cloudflare's current [OAuth documentation](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) supports public clients with token auth method `none` and S256 PKCE. Configure an exact loopback callback in that client. Private/public *visibility* is separate from the OAuth client authentication method; domain verification/public promotion still requires the account owner's decision. Live authorization with two Cloudflare identities has NOT RUN: this environment has no configured Cloudflare client/credentials.

Before claiming an embedded-only implementation, prove: direct Cloudflare API/CORS, trusted credential storage, PKCE callback/refresh, invocation from ChatGPT, and two separate identities on the actual host. No token may pass through model messages or our cloud service.
