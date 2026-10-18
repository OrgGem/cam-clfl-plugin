import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Manager, configSchema } from "../../../packages/local/src/manager.js";
import {
  Operations,
  operationInput,
} from "../../../packages/local/src/operations.js";
import {
  Fault,
  opaque,
  hash,
  now,
} from "../../../packages/local/src/security.js";
export function localApp(
  manager: Manager,
  origin: string,
  launchTicket = opaque(),
) {
  const app = new Hono<{ Variables: { requestId: string } }>(),
    operations = new Operations(manager),
    sessions = new Map<string, number>(),
    flows = new Map<
      string,
      {
        verifier: string;
        expires: number;
        config: z.infer<typeof configSchema>;
        reconnect?: string;
      }
    >();
  let ticket = launchTicket;
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    if (c.req.header("Host") !== new URL(origin).host)
      throw new Fault(403, "invalid_host");
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
    );
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("Origin") !== origin
    )
      throw new Fault(403, "invalid_origin");
    await next();
  });
  app.onError((e, c) =>
    c.json(
      {
        error:
          e instanceof Fault
            ? e.code
            : e instanceof z.ZodError
              ? "invalid_input"
              : "internal_error",
        request_id: c.get("requestId"),
      },
      e instanceof Fault
        ? (e.status as 400)
        : e instanceof z.ZodError
          ? 400
          : 500,
    ),
  );
  app.post("/session", (c) => {
    const supplied =
      c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    const a = Buffer.from(hash(supplied)),
      b = Buffer.from(hash(ticket));
    if (!ticket || !timingSafeEqual(a, b))
      throw new Fault(401, "launch_ticket_invalid");
    ticket = "";
    const session = opaque();
    sessions.set(hash(session), now() + 28800);
    setCookie(c, "gem-local-session", session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 28800,
    });
    return c.json({ ok: true });
  });
  app.get("/health", (c) => c.json({ ok: true, mode: "local-only" }));
  app.use("/api/*", async (c, next) => {
    const session = getCookie(c, "gem-local-session");
    if (!session || (sessions.get(hash(session)) ?? 0) <= now())
      throw new Fault(401, "open_local_launch_url");
    await next();
  });
  app.get("/api/state", async (c) => c.json(await manager.publicState()));
  app.put("/api/config", async (c) => {
    await manager.configure(await c.req.json());
    return c.json({ ok: true });
  });
  app.post("/api/oauth/start", async (c) => {
    const body = z
      .object({ connection_id: z.uuid().optional() })
      .strict()
      .parse(await c.req.json());
    const config = configSchema.parse((await manager.store.read()).config);
    if (
      body.connection_id &&
      !(await manager.store.read()).connections.some(
        (x) => x.id === body.connection_id,
      )
    )
      throw new Fault(404, "connection_not_found");
    for (const [state, flow] of flows)
      if (flow.expires < now()) flows.delete(state);
    const state = opaque(),
      verifier = opaque();
    flows.set(state, {
      verifier,
      expires: now() + 600,
      config,
      reconnect: body.connection_id,
    });
    setCookie(c, "gem-local-oauth", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/oauth",
      maxAge: 600,
    });
    const url = new URL("https://dash.cloudflare.com/oauth2/auth");
    url.search = new URLSearchParams({
      client_id: config.client_id,
      scope: config.scopes,
      response_type: "code",
      redirect_uri: origin + "/oauth/callback",
      state,
      code_challenge: hash(verifier),
      code_challenge_method: "S256",
    }).toString();
    return c.json({ authorization_url: url.toString() });
  });
  app.get("/oauth/callback", async (c) => {
    const state = z.string().parse(c.req.query("state")),
      flow = flows.get(state);
    if (
      !flow ||
      flow.expires < now() ||
      getCookie(c, "gem-local-oauth") !== state
    )
      throw new Fault(400, "oauth_state_or_browser_invalid");
    flows.delete(state);
    deleteCookie(c, "gem-local-oauth", { path: "/oauth" });
    const code = z.string().min(1).max(4096).parse(c.req.query("code"));
    await manager.connect(
      flow.config,
      origin + "/oauth/callback",
      code,
      flow.verifier,
      flow.reconnect,
    );
    return c.redirect("/");
  });
  app.post("/api/connections/:id/confirm", async (c) => {
    await manager.confirm(z.uuid().parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/connections/:id/revoke", async (c) =>
    c.json(await manager.revoke(z.uuid().parse(c.req.param("id")))),
  );
  app.patch("/api/accounts", async (c) => {
    await manager.updateAccount(await c.req.json());
    return c.json({ ok: true });
  });
  app.post("/api/read/:tool", async (c) =>
    c.json(
      await manager.read(
        z
          .enum([
            "list_zones",
            "list_dns_records",
            "list_workers",
            "list_d1_databases",
            "list_tunnels",
          ])
          .parse(c.req.param("tool")),
        await c.req.json(),
        c.get("requestId"),
      ),
    ),
  );
  app.post("/api/operations/preview", async (c) =>
    c.json(await operations.preview(await c.req.json(), c.get("requestId"))),
  );
  app.post("/api/operations/:id/decision", async (c) => {
    const v = z
      .object({
        decision: z.enum(["approve", "reject"]),
        confirmation: z.string().default(""),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await operations.decide(
        z.uuid().parse(c.req.param("id")),
        v.decision,
        v.confirmation,
        c.get("requestId"),
      ),
    );
  });
  app.post("/api/operations/apply", async (c) =>
    c.json(
      await operations.apply(
        operationInput.parse(await c.req.json()).operation_id,
        c.get("requestId"),
      ),
    ),
  );
  app.post("/api/logout", (c) => {
    const session = getCookie(c, "gem-local-session");
    if (session) sessions.delete(hash(session));
    deleteCookie(c, "gem-local-session", { path: "/" });
    return c.json({ ok: true });
  });
  return app;
}
