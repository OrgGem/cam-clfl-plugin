import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalStore, State, Connection } from "./store.js";
import { Vault, Token } from "./vault.js";
import { Cloudflare } from "./cloudflare.js";
import { Fault, now, Target, targetSchema, zoneSchema } from "./security.js";
export const configSchema = z
  .object({
    client_id: z.string().min(1).max(200),
    scopes: z.string().min(1).max(4000),
  })
  .strict();
export const readSchema = targetSchema.extend({
  page: z.number().int().min(1).max(1000).default(1),
});
export const readNames = [
  "list_zones",
  "list_dns_records",
  "list_workers",
  "list_d1_databases",
  "list_tunnels",
] as const;
export type ReadName = (typeof readNames)[number];
export function findConnection(state: State, id: string) {
  const c = state.connections.find((c) => c.id === id);
  if (!c) throw new Fault(404, "connection_not_found");
  return c;
}
export function targetAccount(state: State, v: Target) {
  const c = findConnection(state, v.connection_id);
  if (c.status !== "active")
    throw new Fault(403, "connection_not_active_reconnect_or_confirm");
  const a = c.accounts.find((a) => a.id === v.account_id);
  if (!a) throw new Fault(403, "account_not_in_connection");
  return a;
}
export function log(
  state: State,
  action: string,
  request: string,
  target?: Target,
  operation?: string,
  result = "ok",
) {
  state.audit.push({
    id: randomUUID(),
    at: now(),
    action,
    request_id: request,
    connection_id: target?.connection_id,
    account_id: target?.account_id,
    operation_id: operation,
    result,
  });
}
export class Manager {
  constructor(
    readonly store: LocalStore,
    readonly vault: Vault,
    readonly cf = new Cloudflare(),
  ) {}
  async publicState() {
    const s = await this.store.read();
    return {
      credential_storage: this.vault.storage ?? "custom-vault",
      config: s.config,
      connections: s.connections,
      operations: s.operations,
      audit: s.audit.slice(-200).reverse(),
    };
  }
  async configure(input: unknown) {
    const config = configSchema.parse(input);
    await this.store.transaction(async (s) => {
      if (
        s.config.client_id &&
        s.config.client_id !== config.client_id &&
        s.connections.some((c) => c.status !== "revoked")
      )
        throw new Fault(409, "revoke_connections_before_changing_client");
      s.config = config;
    });
  }
  async connect(
    config: z.infer<typeof configSchema>,
    callback: string,
    code: string,
    verifier: string,
    reconnect?: string,
  ) {
    const token = await this.cf.exchange(
      config.client_id,
      callback,
      code,
      verifier,
    );
    const identity = await this.cf.identity(token),
      accounts = await this.cf.accounts(token);
    return this.store.transaction(async (s, flush) => {
      if (s.config.client_id !== config.client_id)
        throw new Fault(409, "oauth_configuration_changed");
      const existing = reconnect ? findConnection(s, reconnect) : undefined;
      if (existing && existing.subject !== identity.sub)
        throw new Fault(403, "reconnect_identity_mismatch");
      const connection: Connection = {
        id: existing?.id ?? randomUUID(),
        subject: identity.sub,
        identity: identity.email ?? identity.sub,
        status: "pending",
        expires_at: token.expires_at,
        accounts: accounts.map((a) => {
          const old = existing?.accounts.find((x) => x.id === a.id);
          return {
            ...a,
            alias: old?.alias ?? a.id,
            environment: old?.environment ?? "lab",
          };
        }),
      };
      if (existing) Object.assign(existing, connection);
      else s.connections.push(connection);
      await flush();
      await this.vault.set(connection.id, token);
      log(s, "connection.discovered", randomUUID(), undefined);
      return connection;
    });
  }
  async confirm(id: string) {
    await this.store.transaction(async (s) => {
      const c = findConnection(s, id);
      if (c.status !== "pending")
        throw new Fault(409, "connection_not_pending");
      await this.vault.get(id);
      c.status = "active";
      log(s, "connection.confirm", randomUUID());
    });
  }
  async updateAccount(input: unknown) {
    const v = targetSchema
      .extend({
        alias: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
        environment: z.enum(["lab", "production"]),
      })
      .strict()
      .parse(input);
    await this.store.transaction(async (s) => {
      const a = targetAccount(s, v),
        c = findConnection(s, v.connection_id);
      if (c.accounts.some((x) => x.id !== a.id && x.alias === v.alias))
        throw new Fault(409, "alias_already_exists_in_connection");
      a.alias = v.alias;
      a.environment = v.environment;
      log(s, "account.update", randomUUID(), v);
    });
  }
  async revoke(id: string) {
    return this.store.transaction(async (s, flush) => {
      const c = findConnection(s, id);
      c.status = "revoked";
      await flush();
      let upstream = "revoked";
      try {
        await this.cf.revoke(s.config.client_id, await this.vault.get(id));
      } catch {
        upstream = "upstream_revocation_unconfirmed";
      }
      await this.vault.delete(id);
      log(s, "connection.revoke", randomUUID(), undefined, undefined, upstream);
      return { local_status: "revoked", upstream };
    });
  }
  async credentialLocked(
    s: State,
    flush: () => Promise<void>,
    id: string,
  ): Promise<Token> {
    const c = findConnection(s, id);
    if (c.status !== "active")
      throw new Fault(403, "connection_not_active_reconnect_or_confirm");
    let token = await this.vault.get(id);
    if (token.expires_at <= now() + 60) {
      c.status = "refreshing";
      await flush();
      try {
        token = await this.cf.refresh(s.config.client_id, token.refresh_token);
        await this.vault.set(id, token);
        c.expires_at = token.expires_at;
        c.status = "active";
        await flush();
      } catch {
        c.status = "reauth_required";
        await flush();
        throw new Fault(401, "connection_requires_reauthentication");
      }
    }
    return token;
  }
  async credential(id: string) {
    return this.store.transaction((s, flush) =>
      this.credentialLocked(s, flush, id),
    );
  }
  async read(name: ReadName, input: unknown, request: string) {
    const v =
      name === "list_dns_records"
        ? zoneSchema.parse(input)
        : readSchema.parse(input);
    const a = targetAccount(await this.store.read(), v),
      token = await this.credential(v.connection_id);
    if ("zone_id" in v)
      await this.cf.zone(token, v.account_id, z.string().parse(v.zone_id));
    const root = "/accounts/" + v.account_id,
      paths = {
        list_zones: `/zones?account.id=${v.account_id}&per_page=50&page=${v.page}`,
        list_dns_records:
          "zone_id" in v
            ? `/zones/${v.zone_id}/dns_records?per_page=50&page=${v.page}`
            : "",
        list_workers: `${root}/workers/scripts?per_page=50&page=${v.page}`,
        list_d1_databases: `${root}/d1/database?per_page=50&page=${v.page}`,
        list_tunnels: `${root}/cfd_tunnel?is_deleted=false&per_page=50&page=${v.page}`,
      };
    const r = await this.cf.api(token, paths[name]);
    const rows = z.array(z.record(z.string(), z.unknown())).parse(r.result);
    if (name === "list_zones")
      for (const row of rows)
        if (z.object({ id: z.string() }).parse(row.account).id !== v.account_id)
          throw new Fault(403, "zone_account_mismatch");
    const fields =
      name === "list_zones"
        ? ["id", "name", "status"]
        : name === "list_dns_records"
          ? [
              "id",
              "name",
              "type",
              "content",
              "ttl",
              "proxied",
              "priority",
              "modified_on",
            ]
          : name === "list_workers"
            ? ["id", "created_on", "modified_on"]
            : name === "list_d1_databases"
              ? ["uuid", "name", "version", "created_at"]
              : ["id", "name", "status", "created_at", "deleted_at"];
    const result = rows.map((row) =>
      Object.fromEntries(
        fields.filter((k) => k in row).map((k) => [k, row[k]]),
      ),
    );
    await this.store.transaction(async (s) => {
      targetAccount(s, v);
      log(s, name, request, v);
    });
    return {
      connection_id: v.connection_id,
      account_id: v.account_id,
      alias: a.alias,
      request_id: request,
      page: v.page,
      pagination: r.result_info ?? null,
      result,
    };
  }
}
