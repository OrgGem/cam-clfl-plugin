import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fork, spawn } from "node:child_process";
import { opaque, Fault, hash } from "../../../packages/local/src/security.js";
export async function operatorKey(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "operator.key");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      const key = opaque();
      await file.writeFile(key);
      await file.sync();
      return key;
    } finally {
      await file.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const value = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new Fault(503, "local_operator_key_invalid");
    return value;
  }
}
export async function openBrowser(url: string) {
  const program =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32.exe"
          : "xdg-open",
    args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(
      () => reject(new Fault(503, "browser_open_not_confirmed")),
      10000,
    );
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Fault(503, "browser_open_failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Fault(503, "browser_open_failed"));
    });
  });
}
export async function openManager(options: {
  directory: string;
  entry: string;
  port: number;
  browser?: (url: string) => Promise<void>;
  credentialStorage?: string;
}) {
  const origin = "http://127.0.0.1:" + options.port;
  const ready = async () => {
    try {
      const r = await fetch(origin + "/health", {
        signal: AbortSignal.timeout(1000),
      });
      const data = await r.json();
      return (
        r.ok &&
        data.app === "gem-cloudflare-manager" &&
        data.data_id === hash(options.directory)
      );
    } catch {
      return false;
    }
  };
  if (!(await ready()))
    await new Promise<void>((resolve, reject) => {
      const child = fork(options.entry, ["ui"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          GEM_DATA_DIR: options.directory,
          GEM_PORT: String(options.port),
        },
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Fault(503, "local_manager_start_timeout"));
      }, 10000);
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Fault(503, "local_manager_start_failed"));
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Fault(503, "local_manager_port_in_use_or_start_failed"));
      });
      child.on("message", (message) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "gem-ui-ready"
        ) {
          clearTimeout(timeout);
          child.disconnect();
          child.unref();
          resolve();
        }
      });
    });
  if (!(await ready())) throw new Fault(503, "local_manager_identity_mismatch");
  const key = await operatorKey(options.directory),
    r = await fetch(origin + "/operator/launch", {
      method: "POST",
      headers: { Origin: origin, Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(3000),
    });
  if (!r.ok) throw new Fault(503, "local_manager_unlock_failed");
  const data = await r.json();
  if (
    typeof data.ticket !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.ticket)
  )
    throw new Fault(503, "local_manager_invalid_ticket");
  await (options.browser ?? openBrowser)(origin + "/#session=" + data.ticket);
  return {
    opened: true,
    origin,
    credential_storage: options.credentialStorage ?? "os-vault",
  };
}
