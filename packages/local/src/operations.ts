import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Manager, targetAccount, log } from "./manager.js";
import { Operation, State } from "./store.js";
import { Token } from "./vault.js";
import {
  targetSchema,
  dnsSchema,
  Fault,
  now,
  canonical,
  hash,
} from "./security.js";
export const previewSchema = targetSchema
  .extend({
    zone_id: z.string().regex(/^[a-f0-9]{32}$/),
    record_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    record: dnsSchema,
    idempotency_key: z.uuid(),
  })
  .strict();
export const operationInput = z.object({ operation_id: z.uuid() }).strict();
const recordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number(),
  proxied: z.boolean().optional(),
  priority: z.number().optional(),
  modified_on: z.string().optional(),
});
function matches(value: unknown, payload: Operation["payload"]) {
  const row = recordSchema.parse(value);
  return Object.entries(payload).every(
    ([k, v]) => row[k as keyof typeof row] === v,
  );
}
function get(s: State, id: string) {
  const op = s.operations.find((o) => o.id === id);
  if (!op) throw new Fault(404, "operation_not_found");
  targetAccount(s, op);
  return op;
}
export class Operations {
  constructor(readonly manager: Manager) {}
  private async snapshot(
    token: Token,
    op: { zone_id: string; record_id?: string; payload: Operation["payload"] },
  ) {
    if (op.record_id)
      return recordSchema.parse(
        (
          await this.manager.cf.api(
            token,
            `/zones/${op.zone_id}/dns_records/${op.record_id}`,
          )
        ).result,
      );
    const r = await this.manager.cf.api(
      token,
      `/zones/${op.zone_id}/dns_records?name=${encodeURIComponent(op.payload.name)}&type=${op.payload.type}&per_page=100`,
    );
    const rows = z.array(recordSchema).parse(r.result);
    if (rows.length >= 100) throw new Fault(409, "dns_snapshot_limit");
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  async preview(input: unknown, request: string) {
    const v = previewSchema.parse(input);
    return this.manager.store.transaction(async (s, flush) => {
      const account = targetAccount(s, v),
        fingerprint = hash(canonical(v)),
        old = s.operations.find((o) => o.idempotency_key === v.idempotency_key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new Fault(409, "idempotency_payload_mismatch");
        return old;
      }
      const token = await this.manager.credentialLocked(
        s,
        flush,
        v.connection_id,
      );
      await this.manager.cf.zone(token, v.account_id, v.zone_id);
      const before = await this.snapshot(token, { ...v, payload: v.record });
      if (!v.record_id && z.array(z.unknown()).parse(before).length)
        throw new Fault(409, "record_already_exists_use_update");
      if (v.record_id) {
        const row = recordSchema.parse(before);
        if (row.type !== v.record.type || row.name !== v.record.name)
          throw new Fault(400, "rename_or_type_change_not_supported");
        if (matches(row, v.record)) throw new Fault(409, "dns_change_is_noop");
      }
      const op: Operation = {
        id: randomUUID(),
        connection_id: v.connection_id,
        account_id: v.account_id,
        zone_id: v.zone_id,
        record_id: v.record_id,
        payload: v.record,
        before,
        status: "pending",
        environment: account.environment,
        expires_at: now() + 600,
        created_at: now(),
        idempotency_key: v.idempotency_key,
        fingerprint,
        request_id: request,
      };
      s.operations.push(op);
      log(s, "dns.preview", request, v, op.id);
      return op;
    });
  }
  async status(id: string) {
    const s = await this.manager.store.read();
    return get(s, id);
  }
  // This method is bound only to authenticated loopback UI routes, never an MCP tool.
  async decide(
    id: string,
    decision: "approve" | "reject",
    confirmation: string,
    request: string,
  ) {
    return this.manager.store.transaction(async (s) => {
      const op = get(s, id),
        a = targetAccount(s, op);
      if (op.status !== "pending" || op.expires_at <= now())
        throw new Fault(409, "operation_not_pending_or_expired");
      if (op.environment !== a.environment)
        throw new Fault(409, "policy_changed_preview_again");
      if (
        decision === "approve" &&
        a.environment === "production" &&
        confirmation !== `${op.connection_id}/${op.account_id}/${op.zone_id}`
      )
        throw new Fault(400, "production_target_confirmation_required");
      op.status = decision === "approve" ? "approved" : "rejected";
      log(s, "dns." + decision, request, op, op.id);
      return op;
    });
  }
  async apply(id: string, request: string) {
    return this.manager.store.transaction(async (s, flush) => {
      const op = get(s, id),
        account = targetAccount(s, op);
      if (["succeeded", "conflict", "failed", "rejected"].includes(op.status))
        return op;
      const token = await this.manager.credentialLocked(
        s,
        flush,
        op.connection_id,
      );
      await this.manager.cf.zone(token, op.account_id, op.zone_id);
      const finish = (status: Operation["status"], result: unknown) => {
        op.status = status;
        op.result = result;
        log(s, "dns." + status, request, op, op.id);
      };
      const verify = async () => {
        try {
          const actual = await this.snapshot(token, op);
          const match = op.record_id
            ? matches(actual, op.payload)
            : z.array(z.unknown()).parse(actual).length === 1 &&
              matches(z.array(z.unknown()).parse(actual)[0], op.payload);
          finish(match ? "succeeded" : "uncertain", {
            verified: match,
            ...(match
              ? { record: actual }
              : { reason: "upstream_result_not_confirmed_do_not_retry_write" }),
          });
        } catch {
          finish("uncertain", {
            verified: false,
            reason: "verification_unavailable_do_not_retry_write",
          });
        }
        return op;
      };
      if (op.status === "applying" || op.status === "uncertain")
        return verify();
      if (op.status !== "approved" || op.expires_at <= now())
        throw new Fault(409, "valid_local_approval_required");
      if (op.environment !== account.environment)
        throw new Fault(409, "policy_changed_preview_again");
      if (
        s.operations.some(
          (other) =>
            other.id !== op.id &&
            other.account_id === op.account_id &&
            other.zone_id === op.zone_id &&
            other.payload.name === op.payload.name &&
            other.payload.type === op.payload.type &&
            ["applying", "uncertain"].includes(other.status),
        )
      )
        throw new Fault(
          409,
          "dns_target_uncertain_reconcile_previous_operation",
        );
      const before = await this.snapshot(token, op);
      if (canonical(before) !== canonical(op.before)) {
        finish("conflict", { reason: "resource_changed_preview_again" });
        return op;
      }
      // Persist write intent before leaving this process. Replays after a crash only read upstream.
      op.status = "applying";
      await flush();
      try {
        await this.manager.cf.api(
          token,
          `/zones/${op.zone_id}/dns_records${op.record_id ? "/" + op.record_id : ""}`,
          op.record_id ? "PATCH" : "POST",
          op.payload,
        );
      } catch (e) {
        if (e instanceof Fault && e.code === "write_outcome_uncertain")
          return verify();
        finish("failed", {
          error: e instanceof Fault ? e.code : "cloudflare_write_failed",
        });
        return op;
      }
      return verify();
    });
  }
}
