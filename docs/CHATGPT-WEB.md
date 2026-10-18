# Connect to ChatGPT in a browser

ChatGPT web does not start this repository's stdio process itself. The documented private-server path is **Secure MCP Tunnel**: OpenAI's tunnel client runs on your device and invokes the existing local MCP command. This does not introduce a vendor-hosted credential proxy.

```text
ChatGPT web ↔ OpenAI Secure MCP Tunnel ↔ tunnel-client on your device
                                                   ↕ stdio
                                      Gem local MCP → Cloudflare
                                                   ↕
                                               OS vault
```

Cloudflare access/refresh tokens stay with Gem on the device. Tool requests/results traverse OpenAI because ChatGPT uses them; authorized resource content is not confined to the device. The OpenAI tunnel runtime key is a different credential, used by tunnel-client for its control plane. Keep both kinds of credential out of chat, logs and repository files.

## 1. Check account access

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) in your intended organization. Creating a tunnel requires **Tunnels Read + Manage**; the runtime key and operator need **Tunnels Read + Use**. ChatGPT custom MCP access is separately controlled by the ChatGPT workspace.

Associate the tunnel with the target ChatGPT workspace and its intended Platform organization. A tunnel associated only with a Platform organization may not appear in another ChatGPT workspace. Personal accounts should use their personal Platform organization; actual availability still depends on account permissions/product access.

If the required Tunnel or custom MCP controls are absent, stop and resolve account access. This repo cannot enable those permissions, and entering `http://127.0.0.1:3210` as a public MCP URL will not work. The local browser UI port is not a remote MCP endpoint.

## 2. Install Gem on your own device

Use the same OS user for the UI and tunnel processes so they can reach the same OS vault and data directory. Install Node 22.12+ and the platform's supported credential backend.

```sh
git clone --branch feat/local-first https://github.com/OrgGem/cam-clfl-plugin.git
cd cam-clfl-plugin
npm ci
npm run build
npm start
```

Open the private launch URL, configure your Cloudflare public OAuth client and register its exact loopback callback, add a connection, then confirm the identity/accounts. See the root README for OAuth scope and vault requirements. Real OAuth compatibility must be verified on the actual Cloudflare client; no Cloudflare connection is assumed to exist merely because the code builds.

## 3. Configure OpenAI's tunnel client

Install the supported binary from the Platform settings download link or [the latest official release](https://github.com/openai/tunnel-client/releases/latest). Review the current CLI help:

```sh
tunnel-client help quickstart
```

Create/reuse a restricted runtime API key with tunnel Use permission. Supply it locally through the documented `CONTROL_PLANE_API_KEY` environment reference or the client's supported secure credential mechanism. Do not paste its literal value into chat, config files, command arguments or shell history. Shell-specific secure entry instructions depend on your OS.

Use your real tunnel ID and the absolute path of your checkout. Quote paths according to your operating system's shell; the following is a POSIX example for a checkout path without spaces:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile gem-cloudflare \
  --tunnel-id tunnel_YOUR_REAL_ID \
  --mcp-command "node /ABSOLUTE/REPO/dist/node/apps/local/src/cli.js mcp"

tunnel-client doctor --profile gem-cloudflare --explain
tunnel-client run --profile gem-cloudflare
```

Keep the client running. Use its loopback admin UI/readiness checks to verify active polling. If `GEM_DATA_DIR` is customized, give the tunnel-launched process the same value as the UI. Never run the tunnel in a cloud execution environment if the intended vault is on your personal device.

## 4. Add the private plugin in ChatGPT

1. Open **Plugins → + → Add custom MCP server**.
2. Choose **Tunnel** under Connection; select the available tunnel or enter its real ID.
3. The current Gem stdio server has no separate application OAuth layer. Select no additional app authentication if that option is available for the private tunnel; tunnel permissions and the dedicated device process are its access boundary. Do not enter Google/Cloudflare tokens into this form. If your workspace mandates another app-auth layer, that layer is not implemented by the local server and needs a separate integration.
4. Review the tools, warnings and permissions, then choose **Create as a plugin** and install it.
5. Start a new conversation, mention the installed plugin and request `whoami`, then `list_accounts`.

Use a tunnel associated only with the users/workspace that should access this device's connections. The server trusts whoever can reach its stdio transport; it does not implement per-ChatGPT-user access grants. A shared tunnel can expose all local confirmed connections to its authorized callers. This setup is intended for your personal installation.

## 5. Verify before DNS writes

Verify the identity/account labels returned by a real ChatGPT call, then make one read-only inventory request. Record only sanitized request IDs/statuses as evidence. Approve DNS changes exclusively in Gem's local Changes UI; ChatGPT cannot approve through a tool. Keep the companion and tunnel available for the whole workflow.

Setup is complete only after a tool call succeeds **from ChatGPT**, not merely after `doctor` or a local smoke test passes. This implementation session has not created a real tunnel, installed a plugin in your account or run live Cloudflare OAuth. Those actions require your authenticated account and device.

Sources checked: [ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [official tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md).
