import { TABLES, SCHEMA_VERSION } from "./schema.js";
import { latestVersion } from "./migrations/index.js";
import { getAppVersion } from "./version.js";

const migrated = new WeakSet();

function columnDefinition(definition) {
  return definition.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/i, "BIGSERIAL PRIMARY KEY");
}

function createTableSql(name, definition) {
  const columns = Object.entries(definition.columns)
    .map(([column, type]) => `${column} ${columnDefinition(type)}`);
  if (definition.primaryKey) columns.push(definition.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${columns.join(", ")})`;
}

// Supabase owns backups and durability. This path must not touch the local
// SQLite file, whose contents disappear when a Vercel Function is recycled.
function expectedMeta() {
  return {
    schemaVersion: String(latestVersion()),
    backupSchemaVersion: String(SCHEMA_VERSION),
    appVersion: String(getAppVersion()),
  };
}

// Every Vercel cold start reaches this point. When _meta already records the
// current versions, one query is enough — no lock, no DDL round trips.
function isSchemaCurrent(db, expected) {
  const exists = db.get("SELECT to_regclass('_meta') IS NOT NULL AS ok");
  if (!exists?.ok) return false;
  const rows = db.all("SELECT key, value FROM _meta WHERE key IN (?, ?, ?)", Object.keys(expected));
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return Object.entries(expected).every(([key, value]) => stored[key] === value);
}

export function runPostgresMigrationOnce(db) {
  if (migrated.has(db)) return;
  const expected = expectedMeta();
  if (isSchemaCurrent(db, expected)) {
    migrated.add(db);
    return;
  }
  db.transaction(() => {
    // Bound the wait for another instance's migration, and let the server end
    // the transaction if this function is frozen while holding the lock —
    // otherwise every other cold start would queue behind it until timeout.
    db.exec("SET LOCAL lock_timeout = '20s'");
    db.exec("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    db.get("SELECT pg_advisory_xact_lock(9302116)");
    for (const [table, definition] of Object.entries(TABLES)) {
      db.exec(createTableSql(table, definition));
      const existing = new Set(db.all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
        [table.toLowerCase()],
      ).map((row) => row.column_name.toLowerCase()));
      for (const [column, type] of Object.entries(definition.columns)) {
        if (existing.has(column.toLowerCase())) continue;
        const safeType = columnDefinition(type)
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "").trim();
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${safeType}`);
      }
      for (const index of definition.indexes || []) db.exec(index);
    }
    for (const [key, value] of Object.entries(expected)) {
      db.run("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    }
  });
  migrated.add(db);
}
