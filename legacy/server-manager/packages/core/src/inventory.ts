import { z } from "zod";
import {
  Fault,
  CoreEnv,
  Target,
  authorize,
  audit,
  targetSchema,
  zoneSchema,
} from "./security";
import { client } from "./cloudflare";
export async function listConnections(env: CoreEnv, user: string) {
  return (
    await env.DB.prepare(
      `SELECT DISTINCT c.id,c.identity,c.status,c.owner_id=? AS owned FROM cloudflare_connections c LEFT JOIN access_grants g ON g.connection_id=c.id WHERE c.owner_id=? OR (g.user_id=? AND c.status='active' AND EXISTS (SELECT 1 FROM memberships actor JOIN memberships owner ON owner.workspace_id=actor.workspace_id WHERE actor.user_id=g.user_id AND owner.user_id=c.owner_id AND (g.permission='read' OR actor.role IN ('owner','admin','operator'))))`,
    )
      .bind(user, user, user)
      .all()
  ).results;
}
export async function listAccounts(env: CoreEnv, user: string) {
  return (
    await env.DB.prepare(
      `SELECT a.connection_id,a.account_id,a.name,a.alias,a.environment,a.scopes,a.available,c.status FROM connection_accounts a JOIN cloudflare_connections c ON c.id=a.connection_id WHERE c.owner_id=? OR EXISTS (SELECT 1 FROM access_grants g WHERE g.user_id=? AND g.connection_id=a.connection_id AND g.account_id=a.account_id AND c.status='active' AND a.available=1 AND EXISTS (SELECT 1 FROM memberships actor JOIN memberships owner ON owner.workspace_id=actor.workspace_id WHERE actor.user_id=g.user_id AND owner.user_id=c.owner_id AND (g.permission='read' OR actor.role IN ('owner','admin','operator'))))`,
    )
      .bind(user, user)
      .all()
  ).results;
}
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
export async function readInventory(
  env: CoreEnv,
  user: string,
  name: ReadName,
  input: unknown,
  request: string,
) {
  const v =
    name === "list_dns_records"
      ? zoneSchema.parse(input)
      : readSchema.parse(input);
  const target: Target = v;
  const access = await authorize(env, user, target);
  const cf = await client(env, target.connection_id);
  if ("zone_id" in v) await cf.zone(target, z.string().parse(v.zone_id));
  const account = "/accounts/" + target.account_id;
  const paths = {
    list_zones: `/zones?account.id=${target.account_id}&per_page=50&page=${v.page}`,
    list_dns_records:
      "zone_id" in v
        ? `/zones/${v.zone_id}/dns_records?per_page=50&page=${v.page}`
        : "",
    list_workers: `${account}/workers/scripts?per_page=50&page=${v.page}`,
    list_d1_databases: `${account}/d1/database?per_page=50&page=${v.page}`,
    list_tunnels: `${account}/cfd_tunnel?is_deleted=false&per_page=50&page=${v.page}`,
  };
  const data = await cf.call(paths[name]);
  if (name === "list_zones")
    for (const zone of z
      .array(z.object({ account: z.object({ id: z.string() }) }))
      .parse(data.result)) {
      if (zone.account.id !== target.account_id)
        throw new Fault(403, "zone_account_mismatch");
    }
  await authorize(env, user, target);
  await audit(env, user, name, request, target);
  // Explicit allowlists prevent accidental credentials leaking through upstream expansions.
  const result = z
    .array(z.record(z.string(), z.unknown()))
    .parse(data.result)
    .map((row) =>
      Object.fromEntries(
        (name === "list_dns_records"
          ? [
              "id",
              "type",
              "name",
              "content",
              "ttl",
              "proxied",
              "priority",
              "modified_on",
            ]
          : name === "list_zones"
            ? ["id", "name", "status"]
            : name === "list_workers"
              ? ["id", "created_on", "modified_on"]
              : name === "list_d1_databases"
                ? ["uuid", "name", "version", "created_at"]
                : ["id", "name", "status", "created_at", "deleted_at"]
        )
          .filter((k) => k in row)
          .map((k) => [k, row[k]]),
      ),
    );
  return {
    ...target,
    alias: access.alias,
    request_id: request,
    page: v.page,
    pagination: data.result_info ?? null,
    result,
  };
}
