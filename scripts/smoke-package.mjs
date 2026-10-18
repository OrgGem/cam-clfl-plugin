import { unzipSync } from "fflate";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = await mkdtemp(join(tmpdir(), "gem-isolated-package-")),
  data = join(root, "user-data");
let child, exited;
const client = new Client({ name: "package-smoke", version: "1" });
try {
  const files = unzipSync(
    new Uint8Array(await readFile("dist/gem-cloudflare-marketplace.zip")),
  );
  for (const [name, bytes] of Object.entries(files)) {
    const path = resolve(root, name);
    if (
      relative(root, path).startsWith("..") ||
      isAbsolute(relative(root, path))
    )
      throw Error("Archive path escapes package");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  const env = {
    ...process.env,
    GEM_DATA_DIR: data,
    GEM_CREDENTIAL_STORE: "encrypted-file",
    GEM_VAULT_KEY: "invalid-inherited-test-key",
  };
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "plugin/scripts/start.mjs")],
      cwd: root,
      env,
    }),
  );
  const who = await client.callTool({ name: "whoami", arguments: {} });
  if (
    !JSON.stringify(who).includes("os-vault") ||
    JSON.stringify(who).includes("cloud-companion")
  )
    throw Error("Client package did not force OS vault");
  const accounts = await client.callTool({
    name: "list_accounts",
    arguments: {},
  });
  if (accounts.isError) throw Error("Standalone tool call failed");
  await client.close();
  let diagnostics = "";
  child = spawn(process.execPath, [join(root, "plugin/scripts/manage.mjs")], {
    cwd: root,
    env: { ...env, GEM_PORT: "3213" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  exited = once(child, "exit");
  child.stderr.on("data", (chunk) => (diagnostics += String(chunk)));
  for (let i = 0; i < 100 && !diagnostics.includes("#session="); i++)
    await pause(50);
  const ticket = diagnostics.match(/#session=([A-Za-z0-9_-]+)/)?.[1];
  if (!ticket) throw Error("Standalone UI failed to start");
  const origin = "http://127.0.0.1:3213";
  const html = await (await fetch(origin)).text();
  if (!html.includes('id="root"'))
    throw Error("Standalone UI assets unavailable");
  const auth = await fetch(origin + "/session", {
    method: "POST",
    headers: { Origin: origin, Authorization: "Bearer " + ticket },
  });
  if (!auth.ok) throw Error("Standalone session failed");
  console.log(
    "Isolated marketplace ZIP: stdio, forced local custody, UI and session checks passed without source checkout or dependency installation.",
  );
} finally {
  await client.close();
  if (child) {
    child.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
