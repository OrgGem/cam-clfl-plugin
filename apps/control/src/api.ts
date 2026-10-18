import { Hono } from "hono";
import { z } from "zod";
import { Context } from "./auth";
import type { Context as HonoContext } from "hono";
import {
  Fault,
  now,
  audit,
  authorize,
  targetSchema,
  open,
  encryptionKey,
} from "../../../packages/core/src/security";
import { credentials } from "../../../packages/core/src/cloudflare";
import {
  listConnections,
  listAccounts,
} from "../../../packages/core/src/inventory";
import {
  approve,
  operationStatus,
} from "../../../packages/core/src/operations";
export const api = new Hono<Context>();
async function owner(c: HonoContext<Context>, id: string) {
  const r = await c.env.DB.prepare(
    "SELECT id,credential,key_version FROM cloudflare_connections WHERE id=? AND owner_id=?",
  )
    .bind(id, c.get("user"))
    .first<{ id: string; credential: string; key_version: string }>();
  if (!r) throw new Fault(403, "connection_owner_required");
  return r;
}
api.get("/connections", async (c) =>
  c.json(await listConnections(c.env, c.get("user"))),
);
api.get("/accounts", async (c) =>
  c.json(await listAccounts(c.env, c.get("user"))),
);
api.post("/connections/:id/confirm", async (c) => {
  await owner(c, c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE cloudflare_connections SET status='active' WHERE id=? AND owner_id=? AND status='pending_confirmation'",
  )
    .bind(c.req.param("id"), c.get("user"))
    .run();
  await audit(c.env, c.get("user"), "connection.confirm", c.get("requestId"));
  return c.json({ ok: true });
});
api.post("/connections/:id/revoke", async (c) => {
  const row = await owner(c, c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE cloudflare_connections SET status='revoked' WHERE id=? AND owner_id=?",
  )
    .bind(row.id, c.get("user"))
    .run();
  let upstream = "revoked";
  try {
    const t = credentials.parse(
      await open(row.credential, encryptionKey(c.env, row.key_version), row.id),
    );
    const response = await fetch("https://dash.cloudflare.com/oauth2/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " + btoa(c.env.CF_CLIENT_ID + ":" + c.env.CF_CLIENT_SECRET),
      },
      body: new URLSearchParams({
        token: t.refresh_token,
        token_type_hint: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) upstream = "upstream_revocation_unconfirmed";
  } catch {
    upstream = "upstream_revocation_unconfirmed";
  }
  await audit(
    c.env,
    c.get("user"),
    "connection.revoke",
    c.get("requestId"),
    undefined,
    undefined,
    upstream,
  );
  return c.json({ ok: true, local_status: "revoked", upstream });
});
api.patch("/accounts", async (c) => {
  const v = targetSchema
    .extend({
      alias: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
      environment: z.enum(["lab", "production"]),
    })
    .strict()
    .parse(await c.req.json());
  await owner(c, v.connection_id);
  await c.env.DB.prepare(
    "UPDATE connection_accounts SET alias=?,environment=? WHERE connection_id=? AND account_id=?",
  )
    .bind(v.alias, v.environment, v.connection_id, v.account_id)
    .run();
  await audit(c.env, c.get("user"), "account.update", c.get("requestId"), v);
  return c.json({ ok: true });
});
api.get("/operations", async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        "SELECT id,connection_id,account_id,zone_id,status,created_at FROM operations WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(c.get("user"))
        .all()
    ).results,
  ),
);
api.get("/operations/:id", async (c) =>
  c.json(
    await operationStatus(
      c.env,
      c.get("user"),
      z.string().uuid().parse(c.req.param("id")),
    ),
  ),
);
api.post("/operations/:id/decision", async (c) => {
  const b = z
    .object({
      decision: z.enum(["approve", "reject"]),
      confirmation: z.string().default(""),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await approve(
      c.env,
      c.get("user"),
      z.string().uuid().parse(c.req.param("id")),
      b.decision,
      b.confirmation,
      c.get("requestId"),
    ),
  );
});
api.get("/audit", async (c) => {
  const q = z
    .object({
      account_id: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
      request_id: z.string().uuid().optional(),
      from: z.coerce.number().int().min(0).default(0),
    })
    .parse(c.req.query());
  return c.json(
    (
      await c.env.DB.prepare(
        "SELECT * FROM audit_events WHERE user_id=? AND created_at>=? AND (? IS NULL OR account_id=?) AND (? IS NULL OR request_id=?) ORDER BY created_at DESC LIMIT 200",
      )
        .bind(
          c.get("user"),
          q.from,
          q.account_id ?? null,
          q.account_id ?? null,
          q.request_id ?? null,
          q.request_id ?? null,
        )
        .all()
    ).results,
  );
});
api.get("/access", async (c) =>
  c.json({
    memberships: (
      await c.env.DB.prepare(
        "SELECT m.workspace_id,m.user_id,m.role,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id=?)",
      )
        .bind(c.get("user"))
        .all()
    ).results,
    grants: (
      await c.env.DB.prepare(
        "SELECT g.* FROM access_grants g JOIN cloudflare_connections c ON c.id=g.connection_id WHERE c.owner_id=?",
      )
        .bind(c.get("user"))
        .all()
    ).results,
    invitations: (
      await c.env.DB.prepare(
        "SELECT i.id,i.workspace_id,i.role,i.expires_at FROM invitations i JOIN users u ON lower(u.email)=lower(i.email) WHERE u.id=? AND i.accepted_by IS NULL AND i.expires_at>?",
      )
        .bind(c.get("user"), now())
        .all()
    ).results,
  }),
);
api.post("/invitations", async (c) => {
  const b = z
    .object({
      workspace_id: z.string().uuid(),
      email: z.email(),
      role: z.enum(["admin", "operator", "viewer"]),
    })
    .strict()
    .parse(await c.req.json());
  const m = await c.env.DB.prepare(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
  )
    .bind(b.workspace_id, c.get("user"))
    .first<{ role: string }>();
  if (m?.role !== "owner") throw new Fault(403, "workspace_owner_required");
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO invitations (id,workspace_id,email,role,expires_at) VALUES (?,?,?,?,?)",
  )
    .bind(id, b.workspace_id, b.email.toLowerCase(), b.role, now() + 604800)
    .run();
  await audit(c.env, c.get("user"), "invitation.create", c.get("requestId"));
  return c.json({
    id,
    notice:
      "Invitation appears after the recipient signs in with this verified Google email. No email was sent.",
  });
});
api.post("/invitations/:id/accept", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT i.workspace_id,i.role FROM invitations i JOIN users u ON lower(u.email)=lower(i.email) WHERE i.id=? AND u.id=? AND i.accepted_by IS NULL AND i.expires_at>?",
  )
    .bind(id, c.get("user"), now())
    .first<{ workspace_id: string; role: string }>();
  if (!row) throw new Fault(404, "invitation_not_found");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING",
    ).bind(row.workspace_id, c.get("user"), row.role),
    c.env.DB.prepare(
      "UPDATE invitations SET accepted_by=? WHERE id=? AND accepted_by IS NULL",
    ).bind(c.get("user"), id),
  ]);
  await audit(c.env, c.get("user"), "invitation.accept", c.get("requestId"));
  return c.json({ ok: true });
});
api.post("/grants", async (c) => {
  const b = targetSchema
    .extend({
      user_id: z.string().uuid(),
      permission: z.enum(["read", "dns:write"]),
    })
    .strict()
    .parse(await c.req.json());
  await owner(c, b.connection_id);
  const peer = await c.env.DB.prepare(
    "SELECT 1 FROM memberships mine JOIN memberships peer ON mine.workspace_id=peer.workspace_id WHERE mine.user_id=? AND peer.user_id=?",
  )
    .bind(c.get("user"), b.user_id)
    .first();
  if (!peer) throw new Fault(403, "shared_workspace_required");
  await authorize(c.env, c.get("user"), b);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO access_grants VALUES (?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      b.user_id,
      b.connection_id,
      b.account_id,
      b.permission,
    )
    .run();
  await audit(c.env, c.get("user"), "grant.create", c.get("requestId"), b);
  return c.json({ ok: true });
});
api.delete("/grants/:id", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT connection_id,account_id FROM access_grants WHERE id=?",
  )
    .bind(id)
    .first<{ connection_id: string; account_id: string }>();
  if (!row) throw new Fault(404, "grant_not_found");
  await owner(c, row.connection_id);
  await c.env.DB.prepare("DELETE FROM access_grants WHERE id=?").bind(id).run();
  await audit(c.env, c.get("user"), "grant.revoke", c.get("requestId"), row);
  return c.json({ ok: true });
});
api.delete("/mcp-sessions", async (c) => {
  await c.env.DB.prepare("DELETE FROM access_tokens WHERE user_id=?")
    .bind(c.get("user"))
    .run();
  await audit(c.env, c.get("user"), "mcp.revoke", c.get("requestId"));
  return c.json({ ok: true });
});
api.patch("/memberships", async (c) => {
  const b = z
    .object({
      workspace_id: z.string().uuid(),
      user_id: z.string().uuid(),
      role: z.enum(["admin", "operator", "viewer"]),
    })
    .strict()
    .parse(await c.req.json());
  const actor = await c.env.DB.prepare(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
  )
    .bind(b.workspace_id, c.get("user"))
    .first<{ role: string }>();
  if (actor?.role !== "owner" || b.user_id === c.get("user"))
    throw new Fault(403, "workspace_owner_required");
  await c.env.DB.prepare(
    "UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=? AND role<>'owner'",
  )
    .bind(b.role, b.workspace_id, b.user_id)
    .run();
  await audit(c.env, c.get("user"), "membership.role", c.get("requestId"));
  return c.json({ ok: true });
});
api.delete("/memberships/:workspace/:user", async (c) => {
  const workspace = z.string().uuid().parse(c.req.param("workspace")),
    user = z.string().uuid().parse(c.req.param("user"));
  const actor = await c.env.DB.prepare(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
  )
    .bind(workspace, c.get("user"))
    .first<{ role: string }>();
  if (actor?.role !== "owner" || user === c.get("user"))
    throw new Fault(403, "workspace_owner_required");
  await c.env.DB.prepare(
    "DELETE FROM memberships WHERE workspace_id=? AND user_id=? AND role<>'owner'",
  )
    .bind(workspace, user)
    .run();
  await audit(c.env, c.get("user"), "membership.remove", c.get("requestId"));
  return c.json({ ok: true });
});
