import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { MetricsStore } from '../src/metrics.js';

test('an existing database without auto_vacuum is compacted once at open and later cleanup returns freed pages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-sqlite-space-'));
  try {
    const file = path.join(dir, 'hostherd.sqlite');
    // A file created by an earlier version: WAL, auto_vacuum NONE, mostly free pages.
    const legacy = new Database(file);
    legacy.pragma('journal_mode = WAL');
    legacy.exec('CREATE TABLE filler (x TEXT)');
    const insert = legacy.prepare('INSERT INTO filler VALUES (?)');
    legacy.transaction(() => { for (let i = 0; i < 20_000; i++) insert.run('x'.repeat(200)); })();
    legacy.exec('DELETE FROM filler WHERE rowid % 10 != 0');
    assert.equal(legacy.pragma('auto_vacuum', { simple: true }), 0);
    assert.ok((legacy.pragma('freelist_count', { simple: true }) as number) > 100);
    legacy.close();
    const before = (await stat(file)).size;

    const store = new Store(dir);
    try {
      assert.equal(store.db.pragma('auto_vacuum', { simple: true }), 2, 'switched to incremental');
      assert.equal(store.db.pragma('freelist_count', { simple: true }), 0, 'free pages were returned at open');
      assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
      store.db.pragma('wal_checkpoint(TRUNCATE)');
      assert.ok((await stat(file)).size < before / 2, 'the file shrank');
      store.db.exec('DELETE FROM filler WHERE rowid % 20 != 0');
      assert.ok((store.db.pragma('freelist_count', { simple: true }) as number) > 0);
      await store.cleanup();
      assert.equal(store.db.pragma('freelist_count', { simple: true }), 0, 'hourly cleanup reclaims freed pages');
    } finally { store.close(); }

    const reopened = new Store(dir);
    try { assert.equal(reopened.db.pragma('auto_vacuum', { simple: true }), 2); } finally { reopened.close(); }

    const metrics = new MetricsStore(dir);
    try {
      assert.equal(metrics.db.pragma('auto_vacuum', { simple: true }), 2, 'metrics database uses the same mode');
      metrics.cleanup();
      assert.equal(metrics.db.pragma('freelist_count', { simple: true }), 0);
    } finally { metrics.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
