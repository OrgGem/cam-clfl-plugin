import { it, expect, vi } from "vitest";
import { fixture } from "./fixture.js";
import { operatorKey, openManager } from "../apps/local/src/operator.js";
import { localApp } from "../apps/local/src/http.js";
import { hash } from "../packages/local/src/security.js";
import { createMcp } from "../apps/local/src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
it("rotates browser-only launch tickets with local operator authentication, never returns them to tools", async () => {
  const f = await fixture();
  try {
    const key = await operatorKey(f.dir);
    expect(await operatorKey(f.dir)).toBe(key);
    const origin = "http://127.0.0.1:3219",
      app = localApp(f.manager, origin, "initial", {
        key,
        dataId: hash(f.dir),
      });
    const request = (url: string, init: RequestInit = {}) =>
      app.request(url, {
        ...init,
        headers: {
          Host: "127.0.0.1:3219",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    expect(
      (
        await request(origin + "/operator/launch", {
          method: "POST",
          headers: { Origin: origin, Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(403);
    vi.stubGlobal("fetch", request);
    let browserUrl = "";
    const opened = await openManager({
      directory: f.dir,
      entry: "unused-for-existing-manager",
      port: 3219,
      browser: async (url) => {
        browserUrl = url;
      },
    });
    expect(opened).toEqual({
      opened: true,
      origin,
      credential_storage: "os-vault",
    });
    expect(JSON.stringify(opened)).not.toContain("#session");
    expect(JSON.stringify(opened)).not.toContain(key);
    expect(browserUrl).toMatch(/#session=[A-Za-z0-9_-]{43}$/);
    const ticket = browserUrl.split("#session=")[1];
    expect(
      (
        await request(origin + "/session", {
          method: "POST",
          headers: { Origin: origin, Authorization: "Bearer " + ticket },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(origin + "/session", {
          method: "POST",
          headers: { Origin: origin, Authorization: "Bearer " + ticket },
        })
      ).status,
    ).toBe(401);
  } finally {
    vi.unstubAllGlobals();
    await f.cleanup();
  }
});
it("exposes browser opening as a bounded local action rather than returning a login secret", async () => {
  const f = await fixture();
  const [a, b] = InMemoryTransport.createLinkedPair(),
    server = createMcp(f.manager, {
      openManager: async () => ({
        opened: true,
        origin: "http://127.0.0.1:3210",
      }),
    }),
    client = new Client({ name: "operator-test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "open_connection_manager",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining('"opened":true') },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("session=");
  } finally {
    await client.close();
    await server.close();
    await f.cleanup();
  }
});
