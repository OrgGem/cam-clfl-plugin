# Gem Cloudflare Manager — local-first transition

The active implementation is moving to a local companion: OS credential vault, local metadata/journal, local MCP stdio and direct calls from the user's device to Cloudflare. No vendor-hosted token database or resource proxy is part of this architecture.

See [the host capability gate](docs/HOST-CAPABILITIES.md). ChatGPT web/embedded-only support is **not established**. Use a host that supports local stdio MCP (such as the documented Codex configuration).

The previous Workers/D1 manager is preserved under `legacy/server-manager` and on branch `archive/server-manager-v0.1`; it is no longer the default application. Its historical docs/config are not installation instructions for local-first.

Implementation is in progress on `feat/local-first`. Live Cloudflare OAuth requires a public OAuth client (`none` token authentication, S256 PKCE) with an exact loopback redirect URL. No Cloudflare credential has been supplied in this environment.
