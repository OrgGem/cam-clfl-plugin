import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = (args) =>
  execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
run([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--persist-to",
  ".wrangler/e2e",
]);
const t = Math.floor(Date.now() / 1000),
  uid = "11111111-1111-4111-8111-111111111111",
  cid = "22222222-2222-4222-8222-222222222222",
  oid = "33333333-3333-4333-8333-333333333333";
const sql = `DELETE FROM api_leases; DELETE FROM dns_locks; DELETE FROM operation_keys; DELETE FROM approvals; DELETE FROM operations; DELETE FROM audit_events; DELETE FROM access_grants; DELETE FROM connection_accounts; DELETE FROM cloudflare_connections; DELETE FROM invitations; DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM access_tokens; DELETE FROM oauth_codes; DELETE FROM sessions; DELETE FROM users;
INSERT INTO users VALUES ('${uid}','google-e2e','e2e@example.com',${t});
INSERT INTO workspaces VALUES ('${uid}','E2E');
INSERT INTO memberships VALUES ('${uid}','${uid}','owner');
INSERT INTO sessions VALUES ('${createHash("sha256").update("e2e-session").digest("base64url")}','${uid}',${t + 3600});
INSERT INTO cloudflare_connections (id,owner_id,identity,status,credential,key_version,expires_at) VALUES ('${cid}','${uid}','cloudflare@example.com','active','fixture-only','v1',${t + 3600});
INSERT INTO connection_accounts (connection_id,account_id,name,alias,environment,scopes) VALUES ('${cid}','${"a".repeat(32)}','Production test','production','production','dns:write');
INSERT INTO operations (id,user_id,connection_id,account_id,zone_id,payload,before_json,status,expires_at,created_at,request_id) VALUES ('${oid}','${uid}','${cid}','${"a".repeat(32)}','${"b".repeat(32)}','{"type":"A","name":"test.example.com","content":"192.0.2.1","ttl":1,"proxied":false}','[]','pending',${t + 600},${t},'44444444-4444-4444-8444-444444444444');`;
const directory = mkdtempSync(join(tmpdir(), "gem-e2e-"));
try {
  const file = join(directory, "seed.sql");
  writeFileSync(file, sql);
  run([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    ".wrangler/e2e",
    "--file",
    file,
  ]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
