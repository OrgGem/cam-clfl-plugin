import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "gem-loopback-")),
  origin = "http://127.0.0.1:3212";
let diagnostics = "",
  output = "";
const child = spawn(
  process.execPath,
  [resolve("dist/node/apps/local/src/cli.js"), "ui"],
  {
    env: { ...process.env, GEM_DATA_DIR: directory, GEM_PORT: "3212" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stderr.on("data", (chunk) => (diagnostics += String(chunk)));
child.stdout.on("data", (chunk) => (output += String(chunk)));
try {
  for (let i = 0; i < 100 && !diagnostics.includes("#session="); i++)
    await pause(50);
  const ticket = diagnostics.match(/#session=([A-Za-z0-9_-]+)/)?.[1];
  if (!ticket) throw Error("Local UI did not start.");
  const page = await fetch(origin);
  const html = await page.text();
  if (!page.ok || !html.includes('id="root"'))
    throw Error("Compiled UI assets missing.");
  const source = html.match(/src="([^"]+\.js)"/)?.[1];
  if (!source || !(await fetch(origin + source)).ok)
    throw Error("UI bundle missing.");
  if ((await fetch(origin + "/api/state")).status !== 401)
    throw Error("Unauthenticated API was accessible.");
  const auth = await fetch(origin + "/session", {
    method: "POST",
    headers: { Origin: origin, Authorization: "Bearer " + ticket },
  });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  if (!auth.ok || !cookie) throw Error("Loopback bootstrap failed.");
  const state = await fetch(origin + "/api/state", {
    headers: { Cookie: cookie },
  });
  if (!state.ok || output) throw Error("Local UI smoke failed.");
  console.log("Compiled loopback UI/assets/session checks passed.");
} finally {
  const ended = once(child, "exit");
  child.kill();
  await ended;
  await rm(directory, { recursive: true, force: true });
}
