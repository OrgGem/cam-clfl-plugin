import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Connection,
  Operation,
} from "../../../packages/local/src/store.js";
import type { State } from "../../../packages/local/src/store.js";
import "./style.css";
type PublicState = {
  credential_storage?: string;
  config: State["config"];
  connections: Connection[];
  operations: Operation[];
  audit: State["audit"];
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json();
    throw Error(e.error ?? "Request failed");
  }
  return r.json();
}
const boot = async () => {
  const params = new URLSearchParams(location.hash.slice(1)),
    session = params.get("session");
  if (session) {
    history.replaceState(null, "", location.pathname);
    const r = await fetch("/session", {
      method: "POST",
      headers: { Authorization: "Bearer " + session },
    });
    if (!r.ok) throw Error("launch_ticket_invalid");
  }
};
const startup = boot();
function App() {
  const [state, setState] = useState<PublicState | null>(null),
    [view, setView] = useState("Connections"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState(""),
    [zone, setZone] = useState(""),
    [tool, setTool] = useState("list_zones"),
    [page, setPage] = useState(1),
    [result, setResult] = useState<unknown>(null),
    [operation, setOperation] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const load = async () => setState(await api<PublicState>("/state"));
  useEffect(() => {
    startup.then(load).catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice("Completed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const form = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  };
  if (!state)
    return (
      <main className="welcome">
        <span className="brand">GEM / LOCAL</span>
        <h1>
          Your Cloudflare.
          <br />
          On your device.
        </h1>
        <p>
          Start the companion and open the private launch URL printed in your
          terminal.
        </p>
        <code>npm start</code>
        <p role="alert">{error}</p>
      </main>
    );
  const targets = state.connections
      .filter((c) => c.status === "active")
      .flatMap((c) =>
        c.accounts.map((a) => ({
          ...a,
          connection_id: c.id,
          identity: c.identity,
        })),
      ),
    target = targets.find((a) => a.connection_id + "/" + a.id === selected),
    op = state.operations.find((o) => o.id === operation);
  const targetArgs = () => {
    if (!target)
      throw Error("Select an explicit connection and account first.");
    return { connection_id: target.connection_id, account_id: target.id };
  };
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          GEM <span>Cloudflare Local</span>
        </a>
        <nav aria-label="Main">
          {["Connections", "Resources", "Changes"].map((name) => (
            <button
              key={name}
              aria-current={name === view ? "page" : undefined}
              onClick={() => {
                setView(name);
                setError("");
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <footer>
          <strong>
            {state.credential_storage === "cloud-encrypted-file"
              ? "CLOUD COMPANION"
              : "LOCAL DEVICE"}
          </strong>
          <p>
            {state.credential_storage === "cloud-encrypted-file"
              ? "Credentials are encrypted on this cloud host; the master key is supplied by the runtime."
              : "Cloudflare credentials stay in your OS vault. No hosted proxy."}
          </p>
        </footer>
      </aside>
      <main>
        <header>
          <div>
            <small>PERSONAL CONTROL ROOM</small>
            <h1>{view}</h1>
          </div>
          <button disabled={busy} onClick={() => run(load)}>
            Refresh
          </button>
        </header>
        <div className="privacy">
          {state.credential_storage === "cloud-encrypted-file"
            ? "Cloud companion → Cloudflare · Encrypted credential vault"
            : "Device → Cloudflare · No Google login · No shared credential server"}
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {view === "Connections" && (
          <>
            <section>
              <h2>Cloudflare OAuth client</h2>
              <p className="muted">
                Use a public client with token authentication “none” and S256
                PKCE. Register callback{" "}
                <code>{location.origin}/oauth/callback</code>. Client ID is
                public; no client secret is used.
              </p>
              <form
                className="inline"
                onSubmit={(e) => {
                  const b = form(e);
                  run(() => api("/config", "PUT", b));
                }}
              >
                <label>
                  Client ID
                  <input
                    name="client_id"
                    required
                    defaultValue={state.config.client_id}
                  />
                </label>
                <label>
                  Scopes
                  <input
                    name="scopes"
                    required
                    defaultValue={state.config.scopes}
                    placeholder="openid offline_access + approved API scope IDs"
                  />
                </label>
                <button disabled={busy}>Save OAuth configuration</button>
              </form>
              <button
                disabled={busy || !state.config.client_id}
                onClick={() =>
                  run(async () => {
                    const r = await api<{ authorization_url: string }>(
                      "/oauth/start",
                      "POST",
                      {},
                    );
                    location.assign(r.authorization_url);
                  })
                }
              >
                Add Cloudflare connection
              </button>
            </section>
            <div className="cards">
              {state.connections.map((c) => (
                <article key={c.id}>
                  <h2>{c.identity}</h2>
                  <span className="pill">{c.status}</span>
                  <code>Connection {c.id}</code>
                  {c.accounts.map((a) => (
                    <div
                      key={a.id}
                      className={
                        "target " +
                        (a.environment === "production" ? "production" : "")
                      }
                    >
                      <strong>{a.name}</strong>
                      <code>Account {a.id}</code>
                      {c.status === "active" ? (
                        <form
                          onSubmit={(e) => {
                            const b = form(e);
                            run(() =>
                              api("/accounts", "PATCH", {
                                connection_id: c.id,
                                account_id: a.id,
                                ...b,
                              }),
                            );
                          }}
                        >
                          <label>
                            Alias
                            <input
                              name="alias"
                              required
                              pattern="[a-zA-Z0-9_-]{1,50}"
                              defaultValue={a.alias}
                            />
                          </label>
                          <label>
                            Environment
                            <select
                              name="environment"
                              defaultValue={a.environment}
                            >
                              <option value="lab">Lab</option>
                              <option value="production">Production</option>
                            </select>
                          </label>
                          <button disabled={busy}>Save account</button>
                        </form>
                      ) : (
                        <p>
                          {a.alias} · {a.environment}
                        </p>
                      )}
                    </div>
                  ))}
                  <div className="actions">
                    {c.status === "pending" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api("/connections/" + c.id + "/confirm", "POST"),
                          )
                        }
                      >
                        Confirm identity & accounts
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await api<{ authorization_url: string }>(
                            "/oauth/start",
                            "POST",
                            { connection_id: c.id },
                          );
                          location.assign(r.authorization_url);
                        })
                      }
                    >
                      Reconnect same identity
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await api<{ upstream: string }>(
                            "/connections/" + c.id + "/revoke",
                            "POST",
                          );
                          if (r.upstream !== "revoked")
                            throw Error(
                              "Local access revoked; upstream revocation is unconfirmed.",
                            );
                        })
                      }
                    >
                      Revoke connection
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!state.connections.length && (
              <p className="empty">
                No connections yet. Authorize Cloudflare, then verify the
                discovered identity and accounts.
              </p>
            )}
          </>
        )}
        {view === "Resources" && (
          <>
            <section>
              <label>
                Connection / account
                <select
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setResult(null);
                    setZone("");
                  }}
                >
                  <option value="">Choose a target…</option>
                  {targets.map((a) => (
                    <option
                      key={a.connection_id + a.id}
                      value={a.connection_id + "/" + a.id}
                    >
                      {a.alias} · {a.id} · {a.identity} · {a.connection_id}
                    </option>
                  ))}
                </select>
              </label>
              {target && (
                <div
                  className={
                    "target " +
                    (target.environment === "production" ? "production" : "")
                  }
                >
                  <strong>
                    {target.alias} · {target.environment}
                  </strong>
                  <code>Account {target.id}</code>
                  <code>Connection {target.connection_id}</code>
                </div>
              )}
              <div className="inline">
                <label>
                  Inventory
                  <select
                    value={tool}
                    onChange={(e) => setTool(e.target.value)}
                  >
                    {[
                      "list_zones",
                      "list_dns_records",
                      "list_workers",
                      "list_d1_databases",
                      "list_tunnels",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Zone ID
                  <input
                    value={zone}
                    onChange={(e) => setZone(e.target.value)}
                    placeholder="Required for DNS"
                  />
                </label>
                <label>
                  Page
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={page}
                    onChange={(e) => setPage(Number(e.target.value))}
                  />
                </label>
                <button
                  disabled={busy || !target}
                  onClick={() =>
                    run(async () =>
                      setResult(
                        await api("/read/" + tool, "POST", {
                          ...targetArgs(),
                          page,
                          ...(tool === "list_dns_records"
                            ? { zone_id: zone }
                            : {}),
                        }),
                      ),
                    )
                  }
                >
                  Read directly from Cloudflare
                </button>
              </div>
              {result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
            </section>
            <section>
              <h2>Preview a DNS change</h2>
              <p className="muted">
                Uses the connection/account banner above. No write occurs until
                you approve and apply in Changes.
              </p>
              <form
                onSubmit={(e) => {
                  const b = form(e);
                  run(async () => {
                    const operation = await api<Operation>(
                      "/operations/preview",
                      "POST",
                      {
                        ...targetArgs(),
                        zone_id: zone,
                        ...(b.record_id ? { record_id: b.record_id } : {}),
                        idempotency_key: crypto.randomUUID(),
                        record: {
                          type: b.type,
                          name: b.name,
                          content: b.content,
                          ttl: Number(b.ttl),
                          proxied: b.proxied === "on",
                          ...(b.type === "MX"
                            ? { priority: Number(b.priority) }
                            : {}),
                        },
                      },
                    );
                    setOperation(operation.id);
                    setConfirmation("");
                    setView("Changes");
                  });
                }}
              >
                <div className="inline">
                  <label>
                    Type
                    <select name="type">
                      {["A", "AAAA", "CNAME", "TXT", "MX"].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Record name
                    <input
                      name="name"
                      required
                      placeholder="test.example.com"
                    />
                  </label>
                  <label>
                    Record ID (update only)
                    <input name="record_id" />
                  </label>
                </div>
                <label>
                  Content
                  <input name="content" required />
                </label>
                <div className="inline">
                  <label>
                    TTL
                    <input name="ttl" type="number" defaultValue="1" required />
                  </label>
                  <label>
                    MX priority
                    <input name="priority" type="number" defaultValue="10" />
                  </label>
                  <label>
                    Proxied
                    <input name="proxied" type="checkbox" />
                  </label>
                </div>
                <button disabled={busy || !target || !zone}>
                  Create local preview
                </button>
              </form>
            </section>
          </>
        )}
        {view === "Changes" && (
          <>
            <p>
              Approval is performed here on your device. ChatGPT cannot approve
              through an MCP tool.
            </p>
            {state.operations
              .slice()
              .reverse()
              .map((o) => (
                <button
                  className="operation"
                  key={o.id}
                  onClick={() => {
                    setOperation(o.id);
                    setConfirmation("");
                  }}
                >
                  <span>
                    {o.payload.type} {o.payload.name}
                    <code>
                      {o.account_id} · {o.id}
                    </code>
                  </span>
                  <span className="pill">{o.status}</span>
                </button>
              ))}
            {op && (
              <section>
                <div
                  className={
                    "target " +
                    (op.environment === "production" ? "production" : "")
                  }
                >
                  <strong>
                    {op.environment} · {op.payload.name}
                  </strong>
                  <code>Connection {op.connection_id}</code>
                  <code>Account {op.account_id}</code>
                  <code>Zone {op.zone_id}</code>
                </div>
                <div className="diff">
                  <div>
                    <h3>Before</h3>
                    <pre>{JSON.stringify(op.before, null, 2)}</pre>
                  </div>
                  <div>
                    <h3>After</h3>
                    <pre>{JSON.stringify(op.payload, null, 2)}</pre>
                  </div>
                </div>
                <p>
                  State: {op.status} · Approval expires{" "}
                  {new Date(op.expires_at * 1000).toLocaleString()}
                </p>
                {op.status === "pending" && (
                  <>
                    {op.environment === "production" && (
                      <label className="alert">
                        Production: type the exact target
                        <code>
                          {op.connection_id}/{op.account_id}/{op.zone_id}
                        </code>
                        <input
                          value={confirmation}
                          onChange={(e) => setConfirmation(e.target.value)}
                          autoComplete="off"
                        />
                      </label>
                    )}
                    <div className="actions">
                      {(["approve", "reject"] as const).map((decision) => (
                        <button
                          key={decision}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              api(
                                "/operations/" + op.id + "/decision",
                                "POST",
                                { decision, confirmation },
                              ),
                            )
                          }
                        >
                          {decision === "approve"
                            ? "Approve this exact change"
                            : "Reject"}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {["approved", "applying", "uncertain"].includes(op.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api("/operations/apply", "POST", {
                          operation_id: op.id,
                        }),
                      )
                    }
                  >
                    {op.status === "approved"
                      ? "Apply approved change"
                      : "Reconcile with Cloudflare (no repeated write)"}
                  </button>
                )}
                <pre>{JSON.stringify(op.result ?? null, null, 2)}</pre>
              </section>
            )}
            <section>
              <h2>Local activity</h2>
              {state.audit.map((e) => (
                <p key={e.id}>
                  <small>{new Date(e.at * 1000).toLocaleString()}</small> ·{" "}
                  {e.action} · {e.result}
                  <code>
                    {e.account_id} · {e.request_id}
                  </code>
                </p>
              ))}
              {!state.operations.length && (
                <p className="empty">
                  No changes yet. Create a preview from Resources or your local
                  MCP client.
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
