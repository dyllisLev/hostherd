import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import express from 'express';
import { createAuth } from '../apps/server/src/auth.js';

// Exercise the normal authorization-code redirect in a browser, including CSP enforcement.
// Both servers and all credentials belong to this disposable local fixture.
const fixture = await mkdtemp(path.join(tmpdir(), 'hostherd-oauth-browser-'));
const db = new Database(path.join(fixture, 'auth.sqlite'));
const app = express();
const server = createServer(app);
const callbackParameters: URLSearchParams[] = [];
const callback = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/callback') { res.writeHead(204).end(); return; }
  callbackParameters.push(url.searchParams);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html><title>OAuth callback</title><h1>OAuth callback received</h1></html>');
});
const listen = (target: Server) => new Promise<string>(resolve => target.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(target.address() as { port: number }).port}`)));
const close = (target: Server) => new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
let auth: Awaited<ReturnType<typeof createAuth>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let cspViolations = 0;

try {
  const base = await listen(server);
  const callbackBase = await listen(callback);
  const redirectUri = `${callbackBase}/callback`;
  auth = await createAuth({ db, app, dataDir: fixture, publicUrl: base });
  const setupToken = (await readFile(path.join(fixture, 'setup-token'), 'utf8')).trim();
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'browser-check', password: 'local-browser-check-password', setupToken }),
  });
  assert.equal(setup.status, 201);
  const discovery = await (await fetch(`${base}/oauth/.well-known/openid-configuration`)).json();
  const registered = await fetch(discovery.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Browser OAuth check', application_type: 'native', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const resource = `${base}/mcp`;
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirectUri, scope: 'openid offline_access mcp', resource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();

  browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ locale: 'en-US' });
  page.on('console', message => { if (/Content Security Policy|form-action/i.test(message.text())) cspViolations++; });
  await page.goto(authorize.href);
  await expect(page.getByRole('heading', { name: 'Hostherd administrator login' })).toBeVisible();
  await page.getByLabel('Username').fill('browser-check');
  await page.getByLabel('Password').fill('local-browser-check-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approve MCP connection' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow connection', exact: true }).click();
  await page.waitForURL(url => url.origin === callbackBase && url.pathname === '/callback', { timeout: 12_000 });
  await expect(page.getByRole('heading', { name: 'OAuth callback received' })).toBeVisible();
  assert.equal(cspViolations, 0, 'Browser must not block the OAuth redirect under CSP');
  assert.equal(callbackParameters.length, 1);
  assert.equal(callbackParameters[0].get('state'), state);
  const code = callbackParameters[0].get('code');
  assert.ok(code, 'OAuth callback must contain an authorization code');
  const exchange = await fetch(discovery.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource }),
  });
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await auth.authenticateMcp(tokens.access_token))?.subject, 'admin');
  console.log(JSON.stringify({ browser: 'Chrome', oauth: 'DCR + PKCE + browser login + consent + external callback + token exchange passed', cspViolations, callbackRequests: callbackParameters.length }));
} catch {
  // Browser CSP messages can include authorization codes; report only safe diagnostic fields.
  const location = page ? new URL(page.url()) : undefined;
  throw new Error(`OAuth browser check failed; page=${location?.pathname ?? 'not opened'}; CSP violations=${cspViolations}; callback requests=${callbackParameters.length}`);
} finally {
  await browser?.close();
  auth?.close();
  if (server.listening) await close(server);
  if (callback.listening) await close(callback);
  db.close();
  await rm(fixture, { recursive: true, force: true });
}
