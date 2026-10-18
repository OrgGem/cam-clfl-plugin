import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Fault, hash } from "./security.js";
import { Vault, Token, tokenSchema } from "./vault.js";
const envelope = z
  .object({
    version: z.literal(1),
    iv: z.string(),
    tag: z.string(),
    data: z.string(),
  })
  .strict();
// Explicit cloud deployment option. The master key must be supplied separately by the runtime.
export class CloudVault implements Vault {
  readonly storage = "cloud-encrypted-file";
  private directory: string;
  constructor(
    directory: string,
    private keySource: () => string | undefined,
  ) {
    this.directory = resolve(directory, ".credential-vault");
  }
  private key() {
    const text = this.keySource();
    if (!text) throw new Fault(503, "cloud_vault_key_not_configured");
    const key = Buffer.from(text, "base64url");
    if (key.length !== 32 || !/^[A-Za-z0-9_+/=-]+$/.test(text))
      throw new Fault(503, "cloud_vault_key_invalid");
    return key;
  }
  private path(id: string) {
    return join(this.directory, hash(id) + ".json");
  }
  private aad(id: string) {
    return Buffer.from("gem-cloud-vault:v1:" + this.directory + ":" + id);
  }
  async get(id: string): Promise<Token> {
    const key = this.key();
    try {
      const value = envelope.parse(
          JSON.parse(await readFile(this.path(id), "utf8")),
        ),
        iv = Buffer.from(value.iv, "base64url"),
        tag = Buffer.from(value.tag, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw Error();
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(this.aad(id));
      cipher.setAuthTag(tag);
      const bytes = Buffer.concat([
        cipher.update(Buffer.from(value.data, "base64url")),
        cipher.final(),
      ]);
      return tokenSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Fault(503, "cloud_vault_unavailable_or_authentication_failed");
    }
  }
  async set(id: string, token: Token) {
    const key = this.key(),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(this.aad(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(tokenSchema.parse(token)), "utf8"),
      cipher.final(),
    ]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = this.path(id),
      tmp = path + "." + randomUUID();
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          version: 1,
          iv: iv.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
          data: data.toString("base64url"),
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    if (process.platform !== "win32") {
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async delete(id: string) {
    await unlink(this.path(id)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Fault(503, "cloud_vault_delete_failed");
    });
  }
}
