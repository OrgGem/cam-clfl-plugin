// Fixture-only server. Production CLI always uses SystemVault and real Cloudflare endpoints.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fixture } from "../fixture.js";
import { localApp } from "../../apps/local/src/http.js";
const f = await fixture();
await f.connect();
await f.connect();
const app = localApp(
  f.manager,
  "http://127.0.0.1:3211",
  "fixture-launch-ticket",
);
app.use("/*", serveStatic({ root: "dist/ui" }));
const server = serve({ hostname: "127.0.0.1", port: 3211, fetch: app.fetch });
process.on("SIGTERM", () => {
  server.close();
  f.cleanup().finally(() => process.exit());
});
