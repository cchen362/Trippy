import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getDb } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations() {
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  const recordMigration = (file) => {
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  };

  const applySqlMigration = db.transaction((file, sql) => {
    db.exec(sql);
    recordMigration(file);
  });

  const applyJsMigration = db.transaction((file, up) => {
    up(db);
    recordMigration(file);
  });

  for (const file of files) {
    if (applied.has(file)) continue;
    const filePath = join(MIGRATIONS_DIR, file);

    if (file.endsWith('.sql')) {
      const sql = readFileSync(filePath, 'utf8');
      applySqlMigration(file, sql);
    } else {
      const mod = await import(pathToFileURL(filePath).href);
      applyJsMigration(file, mod.up);
    }

    console.log(`Migration applied: ${file}`);
  }
}
