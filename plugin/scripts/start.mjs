import { fileURLToPath } from "node:url";
const entry = new URL("../../dist/node/apps/local/src/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(entry), "mcp"];
try {
  await import(entry.href);
} catch {
  console.error(
    "Gem Local is not built. Run npm ci and npm run build in the repository before installing this local-source plugin.",
  );
  process.exitCode = 1;
}
