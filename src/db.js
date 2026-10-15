import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'perkloop.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

export function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity, entity_id, meta_json)
       VALUES (hex(randomblob(16)), ?, ?, ?, ?, ?)`
    ).run(actorId, action, entity, entityId, JSON.stringify(meta));
  } catch { /* audit must never break txn */ }
}
