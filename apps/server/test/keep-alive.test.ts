import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

test('HTTP keep-alive outlasts a reverse proxy idle timeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-keepalive-'));
  const app = await createApp({ dataDir: dir, publicUrl: 'http://localhost:3000' });
  try {
    assert.equal(app.server.keepAliveTimeout, 65_000);
    assert.equal(app.server.headersTimeout, 66_000);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
