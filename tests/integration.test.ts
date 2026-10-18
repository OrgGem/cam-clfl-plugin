import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { AppEnv, authorize, hash, now } from "../packages/core/src/security";
import { preview, approve, apply } from "../packages/core/src/operations";
import app from "../apps/control/src/worker";
const backend = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  writes: 0,
  timeout: false,
  limited: false,
}));
vi.mock("../packages/core/src/cloudflare", async (original) => {
  const real =
    await original<typeof import("../packages/core/src/cloudflare")>();
  return {
    ...real,
    client: async () =>
      new real.Cloudflare("test", async (url, init) => {
        const u = new URL(String(url));
        if (backend.limited) return new Response("", { status: 429 });
        if (u.pathname.match(/\/zones\/[a-f0-9]+$/))
          return Response.json({
            success: true,
            result: { account: { id: "a".repeat(32) } },
          });
        if (
          init?.method === "POST" ||
          init?.method === "PUT" ||
          init?.method === "PATCH"
        ) {
          backend.writes++;
          const data = JSON.parse(String(init.body));
          backend.records = [
            {
              ...(init?.method === "PATCH" ? backend.records[0] : {}),
              ...data,
              id: "d".repeat(32),
              modified_on: "2026-10-18",
            },
          ];
          if (backend.timeout) throw Error("timeout after commit");
          return Response.json({ success: true, result: backend.records[0] });
        }
        const id = u.pathname.split("/").at(-1);
        return Response.json({
          success: true,
          result:
            id === "dns_records"
              ? backend.records
              : backend.records.find((r) => r.id === id),
        });
      }),
  };
});
const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("ok")}}',
  d1Databases: ["DB"],
});
let env: AppEnv;
const target = {
  connection_id: "11111111-1111-4111-8111-111111111111",
  account_id: "a".repeat(32),
};
const input = {
  ...target,
  zone_id: "b".repeat(32),
  record: {
    type: "A",
    name: "test.example.com",
    content: "192.0.2.1",
    ttl: 1,
    proxied: false,
  },
  idempotency_key: "22222222-2222-4222-8222-222222222222",
};
beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  for (const file of [
    "0001_foundation.sql",
    "0002_operation_guards.sql",
    "0003_connection_lifecycle.sql",
    "0004_approval_policy.sql",
  ]) {
    const sql = await readFile(
      new URL("../migrations/" + file, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  env = {
    DB: db as D1Database,
    APP_ORIGIN: "https://gem.example",
    ASSETS: {
      fetch: async () => new Response("asset"),
      connect: () => {
        throw Error("unused");
      },
    },
    GOOGLE_CLIENT_ID: "test",
    CF_CLIENT_ID: "test",
    CF_SCOPES: "dns:write",
    MCP_CLIENT_ID: "chatgpt",
    MCP_REDIRECT_URIS: "https://chatgpt.com/connector_platform_oauth_redirect",
    KEY_VERSION: "v1",
    GOOGLE_CLIENT_SECRET: "test",
    CF_CLIENT_SECRET: "test",
    CREDENTIAL_KEYS: "{}",
  };
});
afterAll(() => mf.dispose());
beforeEach(async () => {
  backend.records = [];
  backend.writes = 0;
  backend.timeout = false;
  backend.limited = false;
  for (const table of [
    "api_leases",
    "dns_locks",
    "operation_keys",
    "approvals",
    "operations",
    "audit_events",
    "access_tokens",
    "oauth_codes",
    "sessions",
    "access_grants",
    "connection_accounts",
    "cloudflare_connections",
    "memberships",
    "workspaces",
    "users",
  ])
    await env.DB.prepare("DELETE FROM " + table).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES (?,?,?,?)").bind(
      "alice",
      "google-a",
      "a@example.com",
      now(),
    ),
    env.DB.prepare("INSERT INTO users VALUES (?,?,?,?)").bind(
      "bob",
      "google-b",
      "b@example.com",
      now(),
    ),
    env.DB.prepare(
      "INSERT INTO cloudflare_connections (id,owner_id,identity,status,credential,key_version,expires_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      target.connection_id,
      "alice",
      "a@cf.com",
      "active",
      "encrypted",
      "v1",
      now() + 3600,
    ),
    env.DB.prepare("INSERT INTO workspaces VALUES (?,?)").bind("team", "Team"),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(
      "team",
      "alice",
      "owner",
    ),
    env.DB.prepare("INSERT INTO memberships VALUES (?,?,?)").bind(
      "team",
      "bob",
      "operator",
    ),
    env.DB.prepare(
      "INSERT INTO connection_accounts (connection_id,account_id,name,alias,scopes) VALUES (?,?,?,?,?)",
    ).bind(
      target.connection_id,
      target.account_id,
      "Account",
      "lab",
      "read dns:write",
    ),
  ]);
});
it("isolates users and immediately enforces grant revocation", async () => {
  await expect(authorize(env, "bob", target)).rejects.toThrow(
    "target_not_authorized",
  );
  await env.DB.prepare("INSERT INTO access_grants VALUES (?,?,?,?,?)")
    .bind("g", "bob", target.connection_id, target.account_id, "read")
    .run();
  expect((await authorize(env, "bob", target)).alias).toBe("lab");
  await expect(authorize(env, "bob", target, "dns:write")).rejects.toThrow();
  await env.DB.prepare("DELETE FROM access_grants").run();
  await expect(authorize(env, "bob", target)).rejects.toThrow();
});
it("requires real approval, binds actor, and writes exactly once on replay", async () => {
  const p = await preview(env, "alice", input, "r");
  await expect(apply(env, "alice", p.operation_id, "r")).rejects.toThrow(
    "valid_approval_required",
  );
  await expect(
    approve(env, "bob", p.operation_id, "approve", "", "r"),
  ).rejects.toThrow("operation_not_found");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  expect((await apply(env, "alice", p.operation_id, "r")).status).toBe(
    "succeeded",
  );
  expect((await apply(env, "alice", p.operation_id, "r")).status).toBe(
    "succeeded",
  );
  expect(backend.writes).toBe(1);
});
it("reconciles a timeout after upstream committed without another write", async () => {
  const p = await preview(env, "alice", input, "r");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  backend.timeout = true;
  expect((await apply(env, "alice", p.operation_id, "r")).status).toBe(
    "succeeded",
  );
  await apply(env, "alice", p.operation_id, "r");
  expect(backend.writes).toBe(1);
});
it("detects changed upstream data before mutation", async () => {
  const p = await preview(env, "alice", input, "r");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  backend.records = [
    { ...input.record, id: "d".repeat(32), content: "192.0.2.2" },
  ];
  expect((await apply(env, "alice", p.operation_id, "r")).status).toBe(
    "conflict",
  );
  expect(backend.writes).toBe(0);
});
it("revokes approved but unexecuted operations on next request", async () => {
  await env.DB.prepare("INSERT INTO access_grants VALUES (?,?,?,?,?)")
    .bind("g", "bob", target.connection_id, target.account_id, "dns:write")
    .run();
  const p = await preview(env, "bob", input, "r");
  await approve(env, "bob", p.operation_id, "approve", "", "r");
  await env.DB.prepare("DELETE FROM access_grants").run();
  await expect(apply(env, "bob", p.operation_id, "r")).rejects.toThrow(
    "target_not_authorized",
  );
  expect(backend.writes).toBe(0);
});
it("rejects changed idempotency payload and reuses identical preview", async () => {
  const p = await preview(env, "alice", input, "r");
  expect((await preview(env, "alice", input, "r")).operation_id).toBe(
    p.operation_id,
  );
  await expect(
    preview(
      env,
      "alice",
      { ...input, record: { ...input.record, content: "192.0.2.2" } },
      "r",
    ),
  ).rejects.toThrow("idempotency_payload_mismatch");
});
it("requires exact target confirmation for production approval", async () => {
  await env.DB.prepare(
    "UPDATE connection_accounts SET environment='production'",
  ).run();
  const p = await preview(env, "alice", input, "r");
  await expect(
    approve(env, "alice", p.operation_id, "approve", "production", "r"),
  ).rejects.toThrow("production_target_confirmation_required");
});
it("exchanges PKCE code once and validates resource binding", async () => {
  await env.DB.prepare("INSERT INTO oauth_codes VALUES (?,?,?,?,?,?,?)")
    .bind(
      await hash("code"),
      "alice",
      "chatgpt",
      env.MCP_REDIRECT_URIS,
      await hash("v".repeat(43)),
      env.APP_ORIGIN + "/mcp",
      now() + 60,
    )
    .run();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: "code",
    client_id: "chatgpt",
    redirect_uri: env.MCP_REDIRECT_URIS,
    code_verifier: "v".repeat(43),
    resource: env.APP_ORIGIN + "/mcp",
  });
  const req = () =>
    app.request(env.APP_ORIGIN + "/oauth/token", { method: "POST", body }, env);
  const r = await req();
  expect(r.status).toBe(200);
  const token = await r.json<{ access_token: string }>();
  expect(token.access_token).toBeTruthy();
  expect((await req()).status).toBe(400);
});
it("serves actual authenticated MCP tool calls without accepting model user_id", async () => {
  await env.DB.prepare("INSERT INTO access_tokens VALUES (?,?,?,?,?,?)")
    .bind(
      await hash("mcp-token"),
      "alice",
      "chatgpt",
      env.APP_ORIGIN + "/mcp",
      "mcp",
      now() + 60,
    )
    .run();
  const r = await app.request(
    env.APP_ORIGIN + "/mcp",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer mcp-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_accounts", arguments: {} },
      }),
    },
    env,
  );
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("lab");
});
it("downgrading workspace role blocks a DNS grant immediately", async () => {
  await env.DB.prepare("INSERT INTO access_grants VALUES (?,?,?,?,?)")
    .bind("g", "bob", target.connection_id, target.account_id, "dns:write")
    .run();
  await authorize(env, "bob", target, "dns:write");
  await env.DB.prepare(
    "UPDATE memberships SET role='viewer' WHERE user_id='bob'",
  ).run();
  await expect(authorize(env, "bob", target, "dns:write")).rejects.toThrow(
    "workspace_role_not_authorized",
  );
});
it("serializes concurrent apply calls for one operation", async () => {
  const p = await preview(env, "alice", input, "r");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  await Promise.allSettled([
    apply(env, "alice", p.operation_id, "r1"),
    apply(env, "alice", p.operation_id, "r2"),
  ]);
  expect(backend.writes).toBe(1);
});
it("requires a new approval after expiry", async () => {
  const p = await preview(env, "alice", input, "r");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  await env.DB.prepare("UPDATE operations SET expires_at=? WHERE id=?")
    .bind(now() - 1, p.operation_id)
    .run();
  await expect(apply(env, "alice", p.operation_id, "r")).rejects.toThrow(
    "valid_approval_required",
  );
  expect(backend.writes).toBe(0);
});
it("bounds concurrent upstream calls per credential", async () => {
  const real = await vi.importActual<
    typeof import("../packages/core/src/cloudflare")
  >("../packages/core/src/cloudflare");
  for (let i = 0; i < 4; i++)
    await env.DB.prepare("INSERT INTO api_leases VALUES (?,?,?)")
      .bind(String(i), target.connection_id, now() + 30)
      .run();
  const upstream = vi.fn(async () =>
    Response.json({ success: true, result: [] }),
  );
  const cf = new real.Cloudflare("secret", upstream, {
    env,
    connection: target.connection_id,
  });
  await expect(cf.call("/accounts")).rejects.toThrow(
    "connection_concurrency_limit_retry_later",
  );
  expect(upstream).not.toHaveBeenCalled();
});
it("refreshes an expired credential once under concurrent requests", async () => {
  const real = await vi.importActual<
    typeof import("../packages/core/src/cloudflare")
  >("../packages/core/src/cloudflare");
  const { seal, b64 } = await import("../packages/core/src/security");
  const key = b64(crypto.getRandomValues(new Uint8Array(32)));
  env.CREDENTIAL_KEYS = JSON.stringify({ v1: key });
  await env.DB.prepare(
    "UPDATE cloudflare_connections SET credential=?,expires_at=?",
  )
    .bind(
      await seal(
        { access_token: "old", refresh_token: "refresh", scope: "read" },
        key,
        target.connection_id,
      ),
      now() - 1,
    )
    .run();
  const fetcher = vi.fn(async () =>
    Response.json({
      access_token: "new",
      refresh_token: "rotated",
      expires_in: 3600,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const results = await Promise.allSettled([
      real.client(env, target.connection_id),
      real.client(env, target.connection_id),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT status FROM cloudflare_connections WHERE id=?",
      )
        .bind(target.connection_id)
        .first(),
    ).toMatchObject({ status: "active" });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("never uses credentials from another connection after failed refresh", async () => {
  const real = await vi.importActual<
    typeof import("../packages/core/src/cloudflare")
  >("../packages/core/src/cloudflare");
  const { seal, b64 } = await import("../packages/core/src/security");
  const key = b64(crypto.getRandomValues(new Uint8Array(32)));
  env.CREDENTIAL_KEYS = JSON.stringify({ v1: key });
  await env.DB.prepare(
    "UPDATE cloudflare_connections SET credential=?,expires_at=?",
  )
    .bind(
      await seal(
        { access_token: "old", refresh_token: "refresh", scope: "read" },
        key,
        target.connection_id,
      ),
      now() - 1,
    )
    .run();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("secret", { status: 401 })),
  );
  try {
    await expect(real.client(env, target.connection_id)).rejects.toThrow(
      "connection_requires_reauthentication",
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM cloudflare_connections WHERE id=?",
      )
        .bind(target.connection_id)
        .first(),
    ).toMatchObject({ status: "reauth_required" });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("lists three distinct accounts across two identities without leaking a private owner", async () => {
  const { listAccounts, listConnections } =
    await import("../packages/core/src/inventory");
  const c2 = "55555555-5555-4555-8555-555555555555";
  await env.DB.prepare(
    "INSERT INTO cloudflare_connections (id,owner_id,identity,status,credential,key_version,expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(c2, "bob", "second@cf.com", "active", "encrypted", "v1", now() + 3600)
    .run();
  await env.DB.prepare(
    "INSERT INTO connection_accounts (connection_id,account_id,name,alias,scopes) VALUES (?,?,?,?,?),(?,?,?,?,?)",
  )
    .bind(
      c2,
      "c".repeat(32),
      "Same name",
      "personal",
      "read",
      c2,
      "e".repeat(32),
      "Same name",
      "production",
      "read",
    )
    .run();
  expect(await listAccounts(env, "alice")).toHaveLength(1);
  expect(await listAccounts(env, "bob")).toHaveLength(2);
  await env.DB.prepare(
    "INSERT INTO access_grants VALUES (?,?,?,?,?),(?,?,?,?,?)",
  )
    .bind(
      "g1",
      "alice",
      c2,
      "c".repeat(32),
      "read",
      "g2",
      "alice",
      c2,
      "e".repeat(32),
      "read",
    )
    .run();
  expect(await listAccounts(env, "alice")).toHaveLength(3);
  expect(await listConnections(env, "alice")).toHaveLength(2);
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='alice'").run();
  expect(await listAccounts(env, "alice")).toHaveLength(1);
  expect(await listConnections(env, "alice")).toHaveLength(1);
});
it("binds Cloudflare callback to browser state and consumes it once", async () => {
  const { seal, b64 } = await import("../packages/core/src/security");
  const key = b64(crypto.getRandomValues(new Uint8Array(32)));
  env.CREDENTIAL_KEYS = JSON.stringify({ v1: key });
  await env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
    .bind(await hash("browser"), "alice", now() + 60)
    .run();
  const start = await app.request(
    env.APP_ORIGIN + "/auth/cloudflare/start",
    { headers: { Cookie: "__Host-gem-session=browser" } },
    env,
  );
  expect(start.status).toBe(302);
  const url = new URL(start.headers.get("Location")!);
  const state = url.searchParams.get("state")!;
  const path =
    env.APP_ORIGIN + "/auth/cloudflare/callback?state=" + state + "&code=good";
  const wrong = await app.request(
    path,
    { headers: { Cookie: "__Host-gem-session=browser; gem-oauth=wrong" } },
    env,
  );
  expect(wrong.status).toBe(400);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/oauth2/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            scope: "read",
            expires_in: 3600,
          })
        : String(url).includes("/userinfo")
          ? Response.json({ sub: "cf-sub", email: "identity@cf.com" })
          : Response.json({
              success: true,
              result: [{ id: "c".repeat(32), name: "Discovered" }],
            }),
    ),
  );
  try {
    const r = await app.request(
      path,
      { headers: { Cookie: "__Host-gem-session=browser; gem-oauth=" + state } },
      env,
    );
    expect(r.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT identity,status,cf_subject,credential FROM cloudflare_connections WHERE cf_subject=?",
    )
      .bind("cf-sub")
      .first<{
        identity: string;
        status: string;
        cf_subject: string;
        credential: string;
      }>();
    expect(row).toMatchObject({
      identity: "identity@cf.com",
      status: "pending_confirmation",
    });
    expect(row?.credential).not.toContain("access-secret");
    expect(
      (
        await app.request(
          path,
          {
            headers: {
              Cookie: "__Host-gem-session=browser; gem-oauth=" + state,
            },
          },
          env,
        )
      ).status,
    ).toBe(400);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("invalidates an approval when account production policy changes", async () => {
  const p = await preview(env, "alice", input, "r");
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  await env.DB.prepare(
    "UPDATE connection_accounts SET environment='production'",
  ).run();
  await expect(apply(env, "alice", p.operation_id, "r")).rejects.toThrow(
    "valid_approval_required",
  );
  expect(backend.writes).toBe(0);
});
it("delegates account audit only with explicit credential access and current admin role", async () => {
  const { audit } = await import("../packages/core/src/security");
  await audit(
    env,
    "alice",
    "private.login",
    "00000000-0000-4000-8000-000000000001",
  );
  await audit(
    env,
    "alice",
    "account.read",
    "00000000-0000-4000-8000-000000000002",
    target,
  );
  await env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
    .bind(await hash("bob-session"), "bob", now() + 60)
    .run();
  await env.DB.prepare(
    "UPDATE memberships SET role='admin' WHERE user_id='bob'",
  ).run();
  const request = () =>
    app.request(
      env.APP_ORIGIN + "/api/audit",
      { headers: { Cookie: "__Host-gem-session=bob-session" } },
      env,
    );
  expect(await (await request()).json()).toEqual([]);
  await env.DB.prepare("INSERT INTO access_grants VALUES (?,?,?,?,?)")
    .bind("audit-read", "bob", target.connection_id, target.account_id, "read")
    .run();
  expect(await (await request()).json()).toMatchObject([
    { action: "account.read" },
  ]);
  await env.DB.prepare("DELETE FROM access_grants").run();
  expect(await (await request()).json()).toEqual([]);
});
it("patches only approved DNS fields while preserving unpreviewed comments and tags", async () => {
  backend.records = [
    {
      ...input.record,
      id: "d".repeat(32),
      modified_on: "2026-10-18",
      comment: "Keep this comment",
      tags: ["team:lab"],
    },
  ];
  const p = await preview(
    env,
    "alice",
    {
      ...input,
      record_id: "d".repeat(32),
      record: { ...input.record, content: "192.0.2.2" },
    },
    "r",
  );
  await approve(env, "alice", p.operation_id, "approve", "", "r");
  expect((await apply(env, "alice", p.operation_id, "r")).status).toBe(
    "succeeded",
  );
  expect(backend.records[0]).toMatchObject({
    content: "192.0.2.2",
    comment: "Keep this comment",
    tags: ["team:lab"],
  });
  expect(backend.writes).toBe(1);
});
