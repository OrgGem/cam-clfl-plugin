# Install the client plugin through a marketplace

This is a **desktop-only client plugin**. It runs MCP and the account-manager UI on your computer, stores Cloudflare credentials in the OS vault and calls Cloudflare from there. It does not require our cloud backend, a tunnel or an OpenAI API key. It is not a pure browser iframe application.

Current OpenAI documentation permits local MCP plugins in ChatGPT desktop/local threads. It does **not** establish that a stdio client plugin can execute in ChatGPT web. Public Directory submission for local MCP currently requires an approved/allowlisted partner organization and normal review. Publishing this Git marketplace is private/community distribution, not an approved public Directory listing.

## Install from the Git marketplace

Prerequisites: ChatGPT desktop with local-plugin support, Node 22.12+ on PATH, and the Codex CLI for registering marketplace sources. macOS/Windows require a supported OS vault; Linux requires a running Secret Service. Managed workspace policy may restrict installation.

```sh
codex plugin marketplace add OrgGem/cam-clfl-plugin --ref marketplace
```

Restart ChatGPT desktop. Open the Plugins Directory, choose **OrgGem · Cloudflare Local** as the source and install **gem-cloudflare-manager**. Start a local thread and select/mention the plugin.

Ask: **“Open the Cloudflare connection manager.”** The `open_connection_manager` tool starts/reuses the local UI and opens it in your device's default browser. Its temporary login ticket is delivered to the browser, not returned to the model. This browser window is the plugin's management UI; it is not a remote management website.

In Connections, configure a valid Cloudflare OAuth public client (token auth `none`, S256 PKCE, exact loopback callback), add identities, confirm the discovered accounts and assign aliases. A publishing OAuth client must still be provisioned/verified by its owner; the package does not invent a Cloudflare client ID. Live OAuth remains a release gate. Then return to the chat and request `list_accounts` or a read-only inventory.

For DNS, request preview, approve in the local Changes UI and apply the saved operation ID. The model has no approval tool.

## Install a downloaded marketplace ZIP

Download and verify `gem-cloudflare-marketplace.zip` from the GitHub prerelease, then extract it into a permanent directory. The folder contains `.agents/plugins/marketplace.json` and a self-contained `plugin/` directory.

```sh
codex plugin marketplace add /ABSOLUTE/EXTRACTED/MARKETPLACE
```

Use shell-appropriate quoting on paths with spaces (especially Windows). Keep the extracted folder in place while it is registered. The plugin itself is copied into the host's plugin cache; it no longer depends on a source checkout, `npm install`, `npm run build` or parent-directory imports.

The package includes the runtime JS, UI assets and keyring native modules for macOS x64/arm64, Windows x64/arm64 and glibc Linux x64/arm64. Node itself is not bundled. Native execution and vault behavior on each OS still require acceptance; Linux execution is covered by automated isolated-package tests. Alpine/musl and other native platforms are not included in this distribution.

## Public OpenAI Directory submission

`gem-cloudflare-plugin.zip` has `plugin.json` at its root and includes the same runtime/dependencies. It is the package to use for the documented desktop-only submission route, after eligibility is confirmed. It contains no credentials, user state or generated cloud keys.

Do not label the Git marketplace release as public OpenAI Directory publication. The owner still needs developer/business verification, local-MCP submission eligibility, an allowlisted organization, clean desktop install evidence, live OAuth/resource tests and review approval. A ZIP upload alone does not publish a plugin. No account submission or approval is claimed by this repository.

## Updating and development

```sh
codex plugin marketplace upgrade orggem-cloudflare
```

Refresh/reinstall the cached plugin as required by your desktop host. This updates code, not your OS-vault credentials or user data.

Developers build artifacts with `npm run package:plugin` and verify them with `npm run smoke:package`. The smoke test extracts the ZIP outside the checkout, launches its stdio runtime and UI, checks forced OS-vault custody and exercises the browser-opening action with a test browser stub. It does not sign in to a real Cloudflare account or install into a real ChatGPT desktop session.

Sources: [package and marketplace guide](https://developers.openai.com/plugins/build/plugins), [desktop-only publication requirements](https://developers.openai.com/plugins/deploy/desktop-only).
