import { db } from '../src/db.js';

function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`migrated ${table}.${column}`);
  }
}

// Phase 5 columns for business profiles (idempotent for existing DBs)
addColumn('businesses', 'description', `description TEXT NOT NULL DEFAULT ''`);
addColumn('businesses', 'hours_json', `hours_json TEXT NOT NULL DEFAULT '{}'`);

console.log('Migration OK — schema applied.');
console.log('users:', db.prepare('SELECT COUNT(*) c FROM users').get().c);
