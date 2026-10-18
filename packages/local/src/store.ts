import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Fault, dnsSchema } from "./security.js";
export const accountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string(),
    environment: z.enum(["lab", "production"]).default("lab"),
  })
  .strict();
export const connectionSchema = z
  .object({
    id: z.uuid(),
    subject: z.string(),
    identity: z.string(),
    status: z.enum([
      "pending",
      "active",
      "refreshing",
      "reauth_required",
      "revoked",
    ]),
    expires_at: z.number(),
    accounts: z.array(accountSchema),
  })
  .strict();
export const operationSchema = z
  .object({
    id: z.uuid(),
    connection_id: z.uuid(),
    account_id: z.string(),
    zone_id: z.string(),
    record_id: z.string().optional(),
    payload: dnsSchema,
    before: z.unknown(),
    status: z.enum([
      "pending",
      "approved",
      "rejected",
      "applying",
      "uncertain",
      "succeeded",
      "conflict",
      "failed",
    ]),
    environment: z.enum(["lab", "production"]),
    expires_at: z.number(),
    created_at: z.number(),
    idempotency_key: z.uuid(),
    fingerprint: z.string(),
    request_id: z.string(),
    result: z.unknown().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    config: z.object({ client_id: z.string(), scopes: z.string() }).strict(),
    connections: z.array(connectionSchema),
    operations: z.array(operationSchema),
    audit: z.array(
      z.object({
        id: z.uuid(),
        at: z.number(),
        action: z.string(),
        connection_id: z.string().optional(),
        account_id: z.string().optional(),
        operation_id: z.string().optional(),
        request_id: z.string(),
        result: z.string(),
      }),
    ),
  })
  .strict();
export type State = z.infer<typeof stateSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Operation = z.infer<typeof operationSchema>;
export class LocalStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  async read(): Promise<State> {
    try {
      return stateSchema.parse(
        JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 1,
          config: { client_id: "", scopes: "" },
          connections: [],
          operations: [],
          audit: [],
        };
      throw new Fault(500, "local_state_invalid_restore_backup");
    }
  }
  private async save(state: State) {
    const validated = stateSchema.parse(state),
      path = join(this.directory, "state.json"),
      tmp = path + "." + randomUUID();
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(validated));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    if (process.platform !== "win32") {
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async transaction<T>(
    fn: (state: State, checkpoint: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "state.lock");
    let lock;
    const deadline = Date.now() + 20000;
    while (!lock) {
      try {
        lock = await open(path, "wx", 0o600);
        await lock.writeFile(String(process.pid));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > deadline)
          throw new Fault(409, "local_store_busy_retry_later");
        await pause(25);
      }
    }
    try {
      const state = await this.read();
      const result = await fn(state, () => this.save(state));
      await this.save(state);
      return result;
    } finally {
      await lock.close();
      await unlink(path);
    }
  }
}
