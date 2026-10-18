import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  Manager,
  readNames,
  readSchema,
} from "../../../packages/local/src/manager.js";
import {
  Operations,
  previewSchema,
  operationInput,
} from "../../../packages/local/src/operations.js";
import { Fault, zoneSchema } from "../../../packages/local/src/security.js";
export function createMcp(
  manager: Manager,
  local?: { openManager: () => Promise<unknown> },
) {
  const server = new McpServer(
    { name: "Gem Cloudflare Local", version: "0.2.0" },
    {
      instructions:
        "Resolve an explicit connection_id/account_id before every resource call. Credentials stay in the local OS vault. DNS approval occurs only in the local UI; no tool can approve. Reuse operation IDs after timeouts. Uncertain results require reconciliation, never another write. This server runs on the user device, not in a hosted proxy.",
    },
  );
  const ops = new Operations(manager);
  const wrap = async (fn: (request: string) => Promise<unknown>) => {
    const request = randomUUID();
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await fn(request)) },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error:
                e instanceof Fault
                  ? e.code
                  : e instanceof z.ZodError
                    ? "invalid_input"
                    : "internal_error",
              request_id: request,
            }),
          },
        ],
      };
    }
  };
  if (local)
    server.registerTool(
      "open_connection_manager",
      {
        inputSchema: z.object({}).strict(),
        description:
          "Open the private account/connection manager in the user device browser. Use for adding accounts or approving DNS. No launch ticket or credential is returned to the model.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      () => wrap(() => local.openManager()),
    );
  server.registerTool(
    "whoami",
    {
      inputSchema: z.object({}).strict(),
      description:
        "Local device context. Credentials belong to this OS user; no app login or cloud token store.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async (request) => ({
        mode:
          manager.vault.storage === "cloud-encrypted-file"
            ? "cloud-companion"
            : "local-device",
        credential_storage: manager.vault.storage ?? "custom-vault",
        request_id: request,
      })),
  );
  server.registerTool(
    "list_connections",
    {
      inputSchema: z.object({}).strict(),
      description:
        "List local connection identities and status; credential values are never returned.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async (request) => ({
        connections: (await manager.publicState()).connections.map(
          ({ accounts, ...c }) => c,
        ),
        request_id: request,
      })),
  );
  server.registerTool(
    "list_accounts",
    {
      inputSchema: z.object({}).strict(),
      description:
        "List explicit local connection/account targets and aliases. Ask user if ambiguous.",
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(async (request) => ({
        accounts: (await manager.publicState()).connections
          .filter((c) => c.status === "active")
          .flatMap((c) =>
            c.accounts.map((a) => ({
              connection_id: c.id,
              account_id: a.id,
              name: a.name,
              alias: a.alias,
              environment: a.environment,
            })),
          ),
        request_id: request,
      })),
  );
  for (const name of readNames)
    server.registerTool(
      name,
      {
        inputSchema: name === "list_dns_records" ? zoneSchema : readSchema,
        description:
          "Read inventory directly from this device to Cloudflare for one explicit target.",
        annotations: { readOnlyHint: true },
      },
      (args) => wrap((request) => manager.read(name, args, request)),
    );
  server.registerTool(
    "preview_dns_change",
    {
      inputSchema: previewSchema,
      description:
        "Persist a local DNS diff. User must approve it in the companion UI; chat text is not approval.",
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => wrap((request) => ops.preview(args, request)),
  );
  server.registerTool(
    "apply_operation",
    {
      inputSchema: operationInput,
      description:
        "Apply a locally approved operation ID. Replays only reconcile and never repeat writes.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (args) => wrap((request) => ops.apply(args.operation_id, request)),
  );
  server.registerTool(
    "get_operation_status",
    {
      inputSchema: operationInput,
      description: "Read local operation status and verification result.",
      annotations: { readOnlyHint: true },
    },
    (args) => wrap(() => ops.status(args.operation_id)),
  );
  return server;
}
