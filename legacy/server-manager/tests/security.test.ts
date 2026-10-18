import { describe, it, expect } from "vitest";
import {
  seal,
  open,
  b64,
  hash,
  dnsSchema,
  canonical,
} from "../packages/core/src/security";
import { Cloudflare } from "../packages/core/src/cloudflare";
describe("credential isolation", () => {
  it("binds ciphertext to connection and rejects tampering", async () => {
    const key = b64(crypto.getRandomValues(new Uint8Array(32)));
    const data = await seal({ access_token: "secret" }, key, "a");
    expect(data).not.toContain("secret");
    expect(await open(data, key, "a")).toEqual({ access_token: "secret" });
    await expect(open(data, key, "b")).rejects.toThrow();
  });
  it("produces PKCE S256", async () => {
    expect(await hash("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
describe("API boundary", () => {
  it("does not expose upstream bodies or tokens", async () => {
    const cf = new Cloudflare(
      "secret",
      async () => new Response("secret", { status: 429 }),
    );
    await expect(cf.call("/accounts")).rejects.toThrow(
      "cloudflare_rate_limited",
    );
  });
  it("rejects a zone belonging to another account", async () => {
    const cf = new Cloudflare("secret", async () =>
      Response.json({ success: true, result: { account: { id: "b" } } }),
    );
    await expect(
      cf.zone({ connection_id: "c", account_id: "a" }, "z"),
    ).rejects.toThrow("zone_account_mismatch");
  });
  it("marks write transport timeout uncertain", async () => {
    const cf = new Cloudflare("secret", async () => {
      throw Error("secret");
    });
    await expect(cf.call("/zones/z/dns_records", "POST", {})).rejects.toThrow(
      "write_outcome_uncertain",
    );
  });
});
it("validates DNS and canonicalizes comparisons", () => {
  expect(
    dnsSchema.safeParse({ type: "MX", name: "a.com", content: "b.com", ttl: 1 })
      .success,
  ).toBe(false);
  expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
});
it("bounds upstream data before JSON parsing", async () => {
  const { boundedJson } = await import("../packages/core/src/security");
  await expect(boundedJson(new Response("x".repeat(100)), 10)).rejects.toThrow(
    "upstream_response_too_large",
  );
  expect(await boundedJson(Response.json({ ok: true }), 100)).toEqual({
    ok: true,
  });
});
