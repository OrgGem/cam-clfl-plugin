import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { LocalStore } from "../../../packages/local/src/store.js";
import { CloudVault } from "../../../packages/local/src/cloud-vault.js";
import { SystemVault } from "../../../packages/local/src/vault.js";
import { Manager } from "../../../packages/local/src/manager.js";
import { Fault, opaque } from "../../../packages/local/src/security.js";
import { localApp } from "./http.js";
import { createMcp } from "./mcp.js";
async function main() {
  const mode = process.argv[2] ?? "ui",
    directory = resolve(
      process.env.GEM_DATA_DIR ?? join(homedir(), ".gem-cloudflare"),
    );
  const credentialStore = z
    .enum(["os", "encrypted-file"])
    .parse(process.env.GEM_CREDENTIAL_STORE ?? "os");
  const vault =
    credentialStore === "encrypted-file"
      ? new CloudVault(directory, () => process.env.GEM_VAULT_KEY)
      : new SystemVault(directory);
  const store = new LocalStore(directory),
    manager = new Manager(store, vault);
  if (mode === "mcp") {
    await createMcp(manager).connect(new StdioServerTransport());
    return;
  }
  if (mode === "recover-lock") {
    const path = join(directory, "state.lock");
    let pid: number;
    try {
      pid = Number(await readFile(path, "utf8"));
    } catch {
      throw new Fault(409, "no_recoverable_lock");
    }
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Fault(409, "unknown_lock_requires_manual_inspection");
    try {
      process.kill(pid, 0);
      throw new Fault(409, "lock_owner_is_running");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    await unlink(path);
    console.error(
      "Removed lock of stopped process. Pending writes will only reconcile.",
    );
    return;
  }
  if (mode !== "ui") throw new Fault(400, "usage_ui_mcp_or_recover_lock");
  const port = z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .parse(process.env.GEM_PORT ?? 3210),
    origin = "http://127.0.0.1:" + port,
    ticket = opaque(),
    app = localApp(manager, origin, ticket);
  const assets =
    process.env.GEM_UI_DIR ??
    fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../../dist/ui/"
          : "../../../../ui/",
        import.meta.url,
      ),
    );
  app.use("/*", serveStatic({ root: assets }));
  app.get("/", serveStatic({ root: assets, path: "index.html" }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
    console.error(
      "Open this private local launch URL in your browser:\n" +
        origin +
        "/#session=" +
        ticket,
    ),
  );
  server.on("error", () => {
    console.error("Unable to bind local port; no credential was exposed.");
    process.exitCode = 1;
  });
}
main().catch((e) => {
  console.error(e instanceof Fault ? e.code : "local_application_failed");
  process.exitCode = 1;
});
