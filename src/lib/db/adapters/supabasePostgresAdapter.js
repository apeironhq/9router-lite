import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { TABLES } from "../schema.js";

// The existing repositories use a synchronous SQLite adapter, including
// synchronous transaction callbacks. Keep that contract while the PostgreSQL
// socket runs on a worker thread. The socket is never opened in the browser.
const workerCode = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const pg = require(workerData.pgPath);
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
});
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
  if (op === "begin") {
    if (transactionClient) throw new Error("Nested PostgreSQL transactions are not supported");
    transactionClient = await pool.connect();
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

export function createSupabasePostgresAdapter() {
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    throw new Error("POSTGRES_URL is required for Supabase deployment");
  }
  const pgPath = createRequire(path.join(process.cwd(), "package.json")).resolve("pg");
  const worker = new Worker(workerCode, { eval: true, execArgv: [], env: process.env, workerData: { pgPath } });
  worker.on("error", (error) => console.error("[DB] PostgreSQL worker failed:", error));
  worker.on("exit", (code) => { if (code !== 0 && !closed) console.error(`[DB] PostgreSQL worker exited: ${code}`); });
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ port: port2 }, [port2]);
  let sequence = 0;
  let closed = false;

  function call(op, sql, params) {
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
    throw new Error("PostgreSQL query timed out");
  }

  return {
    driver: "supabase-postgres",
    remote: true,
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
      try { call("close"); } finally { closed = true; port1.close(); worker.terminate(); }
    },
  };
}
