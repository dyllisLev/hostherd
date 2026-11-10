import type Database from 'better-sqlite3';

/** PRAGMA auto_vacuum value for INCREMENTAL. */
const INCREMENTAL = 2;

/**
 * Make deleted rows give their space back. Retention deletes rows hourly, but SQLite keeps
 * freed pages inside the file unless auto_vacuum is on, so the file (and every copy taken
 * by a backup) only grows. Switching an existing file to incremental mode needs one VACUUM,
 * which rewrites it once at startup; later calls to reclaimSpace() are cheap.
 */
export function enableIncrementalVacuum(db: Database.Database) {
  if (db.pragma('auto_vacuum', { simple: true }) === INCREMENTAL) return;
  db.pragma('auto_vacuum = INCREMENTAL');
  try { db.exec('VACUUM'); }
  catch (error) {
    // A busy file (for example a backup reading it) must not stop startup; the next start retries.
    console.error('SQLite compaction skipped:', error instanceof Error ? error.message : error);
  }
}

/** Return free pages to the file system. Run after retention deletes rows. */
export function reclaimSpace(db: Database.Database) {
  db.pragma('incremental_vacuum');
}
