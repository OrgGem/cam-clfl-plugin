import { it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  options: undefined as unknown,
  fail: false,
  password: null as string | null,
}));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(_service: string, _id: string, options: unknown) {
      state.options = options;
      if (state.fail) throw Error("private native diagnostics");
    }
    getPassword() {
      return state.password;
    }
    setPassword(value: string) {
      state.password = value;
    }
    deletePassword() {
      state.password = null;
    }
  },
}));
import { SystemVault } from "../packages/local/src/vault.js";
it("requires persistent Secret Service on Linux and fails closed with sanitized errors", async () => {
  const vault = new SystemVault("/device/private");
  state.fail = false;
  await vault.set("id", {
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 1,
    scope: "read",
  });
  expect(state.options).toEqual({ linux: { store: "secret-service" } });
  expect((await vault.get("id")).access_token).toBe("access");
  state.fail = true;
  await expect(vault.get("id")).rejects.toThrow(
    "credential_vault_unavailable_or_locked",
  );
  await expect(
    vault.set("id", {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 1,
      scope: "read",
    }),
  ).rejects.toThrow("credential_vault_unavailable_or_locked");
  state.fail = false;
});
