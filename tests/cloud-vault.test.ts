import { it, expect } from "vitest";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CloudVault } from "../packages/local/src/cloud-vault.js";
import { hash } from "../packages/local/src/security.js";
it("encrypts tokens on cloud disk with separately supplied key and rejects key/connection/ciphertext changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gem-cloud-vault-"));
  try {
    let key = randomBytes(32).toString("base64url");
    const originalKey = key,
      vault = new CloudVault(dir, () => key),
      token = {
        access_token: "private-access",
        refresh_token: "private-refresh",
        scope: "read",
        expires_at: 42,
      };
    await vault.set("first", token);
    const path = join(dir, ".credential-vault", hash("first") + ".json"),
      raw = await readFile(path, "utf8");
    expect(raw).not.toContain("private-access");
    expect(raw).not.toContain(originalKey);
    expect(await vault.get("first")).toEqual(token);
    await copyFile(
      path,
      join(dir, ".credential-vault", hash("second") + ".json"),
    );
    await expect(vault.get("second")).rejects.toThrow("authentication_failed");
    key = randomBytes(32).toString("base64url");
    await expect(vault.get("first")).rejects.toThrow("authentication_failed");
    key = originalKey;
    const modified = JSON.parse(raw);
    modified.data = Buffer.from("tampered").toString("base64url");
    await writeFile(path, JSON.stringify(modified));
    await expect(vault.get("first")).rejects.toThrow("authentication_failed");
    await vault.delete("first");
    await vault.delete("second");
    expect(await readdir(join(dir, ".credential-vault"))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("requires explicit 256-bit master key and has no plaintext fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gem-cloud-vault-"));
  try {
    const vault = new CloudVault(dir, () => undefined);
    await expect(vault.get("id")).rejects.toThrow(
      "cloud_vault_key_not_configured",
    );
    await expect(new CloudVault(dir, () => "short").get("id")).rejects.toThrow(
      "cloud_vault_key_invalid",
    );
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
