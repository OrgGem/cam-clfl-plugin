import { Entry } from "@napi-rs/keyring";
import { z } from "zod";
import { Fault, hash } from "./security.js";
export const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    scope: z.string(),
    expires_at: z.number(),
  })
  .strict();
export type Token = z.infer<typeof tokenSchema>;
export interface Vault {
  readonly storage?: string;
  get(id: string): Promise<Token>;
  set(id: string, token: Token): Promise<void>;
  delete(id: string): Promise<void>;
}
export class SystemVault implements Vault {
  readonly storage = "os-vault";
  constructor(private namespace: string) {}
  private entry(id: string) {
    return new Entry("orggem.gem-cloudflare." + hash(this.namespace), id, {
      linux: { store: "secret-service" },
    });
  }
  async get(id: string) {
    try {
      const value = this.entry(id).getPassword();
      if (!value) throw Error();
      return tokenSchema.parse(JSON.parse(value));
    } catch {
      throw new Fault(503, "credential_vault_unavailable_or_locked");
    }
  }
  async set(id: string, token: Token) {
    try {
      this.entry(id).setPassword(JSON.stringify(tokenSchema.parse(token)));
    } catch {
      throw new Fault(503, "credential_vault_unavailable_or_locked");
    }
  }
  async delete(id: string) {
    try {
      this.entry(id).deletePassword();
    } catch {
      throw new Fault(503, "credential_vault_unavailable_or_locked");
    }
  }
}
