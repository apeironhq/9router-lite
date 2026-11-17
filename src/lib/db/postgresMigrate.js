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
export function runPostgresMigrationOnce(db) {
  if (migrated.has(db)) return;
  db.transaction(() => {
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
    for (const [key, value] of Object.entries({
      schemaVersion: latestVersion(),
      backupSchemaVersion: SCHEMA_VERSION,
      appVersion: getAppVersion(),
    })) {
      db.run("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
    }
  });
  migrated.add(db);
}
