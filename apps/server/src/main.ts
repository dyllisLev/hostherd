import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
if (process.env.NODE_ENV === 'production' && !publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must use HTTPS in production');
const app = await createApp({ dataDir: path.resolve(process.env.DATA_DIR ?? './data'), publicUrl,
  releaseDir: process.env.RELEASE_DIR, webDir: process.env.WEB_DIR });
app.server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Hostherd listening on port ${port}; public URL ${publicUrl}`));
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await app.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
