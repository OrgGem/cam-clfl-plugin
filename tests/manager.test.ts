import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixture.js";
import { now } from "../packages/local/src/security.js";
it("discovers two identities and three accounts with tokens only in the vault", async () => {
  const f = await fixture();
  try {
    const a = await f.connect(),
      b = await f.connect();
    expect(a.accounts).toHaveLength(1);
    expect(b.accounts).toHaveLength(2);
    expect(a.subject).not.toBe(b.subject);
    expect(await readFile(join(f.dir, "state.json"), "utf8")).not.toContain(
      "fake-access",
    );
    expect(JSON.stringify(await f.manager.publicState())).not.toContain(
      "fake-refresh",
    );
    expect(
      f.backend.calls.every((c) =>
        ["dash.cloudflare.com", "api.cloudflare.com"].includes(
          new URL(c.url).hostname,
        ),
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});
it("rejects account swapping and strips unexpected upstream credential fields", async () => {
  const f = await fixture();
  try {
    const a = await f.connect();
    await expect(
      f.manager.read(
        "list_workers",
        { connection_id: a.id, account_id: "b".repeat(32) },
        "request",
      ),
    ).rejects.toThrow("account_not_in_connection");
    const result = await f.manager.read(
      "list_workers",
      { connection_id: a.id, account_id: "a".repeat(32) },
      "request",
    );
    expect(result.result).toEqual([{ id: "same-resource" }]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  } finally {
    await f.cleanup();
  }
});
it("serializes token refresh and revokes the next request independently", async () => {
  const f = await fixture();
  try {
    const a = await f.connect(),
      b = await f.connect();
    const t = await f.vault.get(a.id);
    await f.vault.set(a.id, { ...t, expires_at: now() - 1 });
    await Promise.all([f.manager.credential(a.id), f.manager.credential(a.id)]);
    expect(f.backend.refreshes).toBe(1);
    await f.manager.revoke(a.id);
    await expect(f.manager.credential(a.id)).rejects.toThrow(
      "connection_not_active",
    );
    expect(await f.manager.credential(b.id)).toBeTruthy();
  } finally {
    await f.cleanup();
  }
});
it("fails closed after refresh failure and does not switch identities", async () => {
  const f = await fixture();
  try {
    const a = await f.connect();
    await f.vault.set(a.id, {
      ...(await f.vault.get(a.id)),
      expires_at: now() - 1,
    });
    f.backend.refreshFails = true;
    await expect(f.manager.credential(a.id)).rejects.toThrow(
      "connection_requires_reauthentication",
    );
    expect((await f.store.read()).connections[0].status).toBe(
      "reauth_required",
    );
  } finally {
    await f.cleanup();
  }
});
it("requires the same subject on reconnect and sanitizes 429", async () => {
  const f = await fixture();
  try {
    const a = await f.connect();
    await expect(
      f.manager.connect(
        { client_id: "public-client", scopes: "openid offline_access" },
        "http://127.0.0.1:3210/oauth/callback",
        "code",
        "verifier",
        a.id,
      ),
    ).rejects.toThrow("reconnect_identity_mismatch");
    f.backend.rateLimit = true;
    await expect(
      f.manager.read(
        "list_workers",
        { connection_id: a.id, account_id: "a".repeat(32) },
        "r",
      ),
    ).rejects.toThrow("cloudflare_rate_limited");
  } finally {
    await f.cleanup();
  }
});
