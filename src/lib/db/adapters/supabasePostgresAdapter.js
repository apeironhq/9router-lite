import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
// Not used on this thread. The static import makes Next.js output tracing
// ship `pg` with its whole dependency tree (postgres-array, pgpass, …) in
// every function that reaches this adapter; the worker below only loads `pg`
// from source text, which tracing cannot see.
import "pg";
import { TABLES } from "../schema.js";

// The existing repositories use a synchronous SQLite adapter, including
// synchronous transaction callbacks. Keep that contract while the PostgreSQL
// socket runs on a worker thread. The socket is never opened in the browser.
// `pg` is resolved inside the worker source: webpack rewrites createRequire()
// .resolve() in bundled code into a numeric module id, which require() rejects.
const workerCode = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const nodePath = require("node:path");
// A load failure is reported on every call instead of crashing the worker,
// which would leave the caller waiting for the full query timeout.
let pool = null;
let loadError = null;
try {
  const pg = createRequire(nodePath.join(process.cwd(), "package.json"))("pg");
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);
  pool = new pg.Pool({
    connectionString: workerData.connectionString,
    max: 1,
    ssl: workerData.ssl,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", () => {});
} catch (error) {
  loadError = error;
}
let transactionClient = null;

function placeholders(sql) {
  let index = 0;
  let quote = null;
  let result = "";
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === "?") {
      result += "$" + (++index);
    } else {
      result += char;
    }
  }
  return result;
}

function normalizeSql(sql) {
  let out = sql.trim();
  const replace = /^INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)$/i.exec(out);
  if (replace) {
    const [, table, columns, values] = replace;
    const names = columns.split(",").map((name) => name.trim());
    const keys = table.toLowerCase() === "kv" ? ["scope", "key"]
      : table.toLowerCase() === "usagedaily" ? ["dateKey"] : ["id"];
    const updates = names.filter((name) => !keys.some((key) => key.toLowerCase() === name.toLowerCase()))
      .map((name) => name + " = EXCLUDED." + name);
    out = "INSERT INTO " + table + "(" + columns + ") VALUES(" + values + ") ON CONFLICT (" + keys.join(", ") + ") "
      + (updates.length ? "DO UPDATE SET " + updates.join(", ") : "DO NOTHING");
  }
  if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(out)) {
    out = out.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT INTO ") + " ON CONFLICT DO NOTHING";
  }
  return placeholders(out);
}

async function handle(message) {
  const { op, sql, params = [] } = message;
  if (loadError) throw new Error("PostgreSQL driver (pg) failed to load in the database worker: " + loadError.message);
  if (op === "begin") {
    if (transactionClient) throw new Error("Nested PostgreSQL transactions are not supported");
    transactionClient = await pool.connect();
    // A checked-out client has no pool error listener; a dropped connection
    // would otherwise raise an unhandled 'error' and kill the worker.
    transactionClient.on("error", () => {});
    try { await transactionClient.query("BEGIN"); }
    catch (error) { transactionClient.release(); transactionClient = null; throw error; }
    return null;
  }
  if (op === "commit" || op === "rollback") {
    if (!transactionClient) throw new Error("No active PostgreSQL transaction");
    const client = transactionClient;
    transactionClient = null;
    try { await client.query(op === "commit" ? "COMMIT" : "ROLLBACK"); }
    finally { client.release(); }
    return null;
  }
  if (op === "close") { await pool.end(); return null; }
  const client = transactionClient || pool;
  const result = await client.query(normalizeSql(sql), params);
  if (op === "run") return { changes: result.rowCount || 0, lastInsertRowid: null };
  if (op === "get") return result.rows[0];
  if (op === "all") return result.rows;
  if (op === "exec") return null;
  throw new Error("Unknown database operation: " + op);
}

parentPort.once("message", ({ port }) => {
  port.on("message", async (message) => {
    try {
      const value = await handle(message);
      port.postMessage({ id: message.id, ok: true, value });
    } catch (error) {
      port.postMessage({ id: message.id, ok: false, error: error.message, code: error.code });
    } finally {
      Atomics.store(new Int32Array(message.signal), 0, 1);
      Atomics.notify(new Int32Array(message.signal), 0);
    }
  });
});
`;

const names = new Map();
for (const definition of Object.values(TABLES)) {
  for (const name of Object.keys(definition.columns)) names.set(name.toLowerCase(), name);
}

function restoreColumnNames(row) {
  if (!row) return row;
  const restored = {};
  for (const [key, value] of Object.entries(row)) restored[names.get(key.toLowerCase()) || key] = value;
  return restored;
}

// SSL is configured only through POSTGRES_SSL / POSTGRES_CA_CERT so the rule is
// the same for every provider. sslmode-style URL parameters are removed because
// pg lets them override the `ssl` option silently.
//   verify (default) — verify the server certificate against public CAs, or
//                      against POSTGRES_CA_CERT when set (Supabase uses its own CA).
//   no-verify        — encrypt without verifying the certificate.
//   disable          — no TLS (local PostgreSQL only).
const SSL_URL_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"];

export function resolvePostgresConnection(env = process.env) {
  const raw = env.POSTGRES_URL || env.DATABASE_URL;
  if (!raw) throw new Error("POSTGRES_URL or DATABASE_URL is required for PostgreSQL storage");
  let connectionString = raw;
  try {
    const url = new URL(raw);
    for (const name of SSL_URL_PARAMS) url.searchParams.delete(name);
    connectionString = url.toString();
  } catch {
    throw new Error("POSTGRES_URL is not a valid postgresql:// URL");
  }

  const mode = String(env.POSTGRES_SSL || "verify").trim().toLowerCase();
  let ssl;
  if (mode === "disable") ssl = false;
  else if (mode === "no-verify") ssl = { rejectUnauthorized: false };
  else if (mode === "verify") {
    // Vercel env values cannot hold real newlines when pasted on one line.
    const ca = env.POSTGRES_CA_CERT ? env.POSTGRES_CA_CERT.replace(/\\n/g, "\n") : undefined;
    ssl = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  } else {
    throw new Error(`POSTGRES_SSL must be verify, no-verify or disable (got "${mode}")`);
  }
  return { connectionString, ssl };
}

export function createSupabasePostgresAdapter() {
  const { connectionString, ssl } = resolvePostgresConnection();
  const worker = new Worker(workerCode, { eval: true, execArgv: [], env: process.env, workerData: { connectionString, ssl } });
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ port: port2 }, [port2]);
  let sequence = 0;
  let closed = false;
  // Set when the worker dies or a call times out. The driver then drops this
  // adapter and builds a fresh one, so a warm Vercel instance recovers on the
  // next request instead of timing out on every query until it is recycled.
  let broken = null;
  worker.on("error", (error) => { broken = broken || error; console.error("[DB] PostgreSQL worker failed:", error); });
  worker.on("exit", (code) => {
    if (closed) return;
    broken = broken || new Error(`PostgreSQL worker exited with code ${code}`);
    console.error(`[DB] PostgreSQL worker exited: ${code}`);
  });

  function discard(reason) {
    broken = broken || reason;
    closed = true;
    try { port1.close(); } catch {}
    worker.terminate().catch(() => {});
  }

  function call(op, sql, params) {
    if (broken) throw new Error(`PostgreSQL adapter unavailable: ${broken.message}`);
    if (closed) throw new Error("PostgreSQL adapter is closed");
    const id = ++sequence;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    port1.postMessage({ id, op, sql, params, signal: signal.buffer });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const packet = receiveMessageOnPort(port1)?.message;
      if (packet) {
        if (packet.id !== id) throw new Error("PostgreSQL response order mismatch");
        if (!packet.ok) {
          const error = new Error(packet.error);
          error.code = packet.code;
          throw error;
        }
        return packet.value;
      }
      Atomics.wait(signal, 0, 0, Math.min(1000, deadline - Date.now()));
    }
    // The worker may still answer later or hold an open transaction; replies
    // would then be matched to the wrong call. Throw the whole adapter away —
    // terminating the worker closes its connection and any transaction.
    const error = new Error("PostgreSQL query timed out");
    discard(error);
    throw error;
  }

  return {
    driver: "supabase-postgres",
    remote: true,
    get broken() { return Boolean(broken); },
    run: (sql, params = []) => call("run", sql, params),
    get: (sql, params = []) => restoreColumnNames(call("get", sql, params)),
    all: (sql, params = []) => call("all", sql, params).map(restoreColumnNames),
    exec: (sql) => call("exec", sql),
    transaction(fn) {
      call("begin");
      try {
        const value = fn();
        if (value && typeof value.then === "function") throw new Error("Async transaction callbacks are not supported");
        call("commit");
        return value;
      } catch (error) {
        try { call("rollback"); } catch {}
        throw error;
      }
    },
    checkpoint() {},
    close() {
      try { if (!broken) call("close"); } finally { discard(new Error("closed")); }
    },
  };
}
