import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
const packaged = new URL("../server/index.mjs", import.meta.url),
  checkout = new URL("../../dist/node/apps/local/src/cli.js", import.meta.url);
let entry = packaged;
try {
  await access(packaged);
} catch {
  entry = checkout;
}
// Client-only package: never inherit an opt-in cloud credential store from the host.
process.env.GEM_CREDENTIAL_STORE = "os";
delete process.env.GEM_VAULT_KEY;
if (entry === packaged)
  process.env.GEM_UI_DIR = fileURLToPath(
    new URL("../server/ui/", import.meta.url),
  );
process.argv = [process.execPath, fileURLToPath(entry), "mcp"];
try {
  await import(entry.href);
} catch {
  console.error(
    "Gem Local runtime is unavailable. Install the self-contained marketplace package or build the source checkout. Node 22.12+ is required.",
  );
  process.exitCode = 1;
}
