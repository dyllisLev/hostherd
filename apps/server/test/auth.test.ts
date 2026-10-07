import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { createAuth, loginKey } from '../src/auth.js';

class Browser {
  cookies = new Map<string, string>();
  /** Sent with every request, e.g. Accept-Language. */
  headers: Record<string, string> = {};
  constructor(readonly base: string) {}
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers({ ...this.headers, ...Object.fromEntries(new Headers(init.headers)) });
    headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(new URL(url, this.base), { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const key = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return response;
  }
  async json(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.request(url, { method, headers: { 'Content-Type': 'application/json', Origin: this.base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async follow(response: Response): Promise<{ response: Response; callback?: URL }> {
    for (let n = 0; n < 15; n++) {
      const location = response.headers.get('location');
      if (!location) return { response };
      const next = new URL(location, this.base);
      if (next.origin !== this.base) return { response, callback: next };
      response = await this.request(next.href);
    }
    throw new Error('Too many OAuth redirects');
  }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hostherd-auth-'));
  let db: Database.Database;
  let auth: Awaited<ReturnType<typeof createAuth>>;
  let server: Server;
  let base: string;
  async function start(port = 0) {
    db = new Database(path.join(dir, 'test.sqlite'));
    const app = express();
    app.set('trust proxy', 'loopback');
    // Fixtures deliberately replace the listening server; avoid reusing a stale client socket.
    app.use((_req, res, next) => { res.set('Connection', 'close'); next(); });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    auth = await createAuth({ db, app, dataDir: dir, publicUrl: base });
    app.use(express.json());
    app.get('/api/private', auth.requireAdmin, (_req, res) => res.json({ ok: true }));
    app.post('/mcp', async (req, res) => {
      const identity = await auth.authenticateMcp((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      res.status(identity ? 200 : 401).json(identity ?? { error: 'unauthorized' });
    });
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  }
  async function stop() {
    auth.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
  await start();
  const browser = new Browser(base!);
  async function setup() {
    const setupToken = (await readFile(path.join(dir, 'setup-token'), 'utf8')).trim();
    const response = await browser.json('/api/setup', 'POST', { username: 'owner', password: 'correct-password', setupToken });
    assert.equal(response.status, 201, await response.text());
  }
  return {
    dir, browser, setup, get base() { return base; }, get db() { return db; }, get auth() { return auth; },
    restart: async () => { const port = Number(new URL(base).port); await stop(); await start(port); },
    close: async () => { await stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('administrator setup, sessions, PAT, same-origin protection, and persistence', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await stat(path.join(f.dir, 'setup-token'))).mode & 0o777, 0o600);
  assert.deepEqual(await (await f.browser.request('/api/me')).json(), { authenticated: false, setupRequired: true });
  assert.equal((await f.browser.request('/api/private')).status, 401);
  const wrongToken = await f.browser.json('/api/setup', 'POST', { username: 'owner', password: 'correct-password', setupToken: 'wrong' });
  assert.equal(wrongToken.status, 403);
  assert.deepEqual(await wrongToken.json(), { code: 'INVALID_SETUP_TOKEN', error: 'The setup token is incorrect.' });
  assert.deepEqual(await (await f.browser.request('/api/private')).json(), { code: 'LOGIN_REQUIRED', error: 'Administrator login is required.' });
  await f.setup();
  assert.deepEqual(await (await f.browser.request('/api/me')).json(), { authenticated: true, username: 'owner', setupRequired: false });
  assert.equal((await f.browser.json('/api/setup', 'POST', {})).status, 409);
  assert.equal((await f.browser.json('/api/tokens', 'POST', { name: 'bad origin' }, { Origin: 'https://attacker.invalid' })).status, 403);
  const patResponse = await f.browser.json('/api/tokens', 'POST', { name: 'local test' });
  assert.equal(patResponse.status, 201);
  const pat = await patResponse.json() as { id: string; token: string };
  assert.equal((await f.auth.authenticateMcp(pat.token))?.clientId, `pat:${pat.id}`);
  const listed = await (await f.browser.request('/api/tokens')).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, undefined);
  const row = f.db.prepare('SELECT token_hash FROM auth_pats WHERE id=?').get(pat.id) as { token_hash: string };
  assert.match(pat.token, /^hostherd_/);
  assert.notEqual(row.token_hash, pat.token);
  assert.equal(row.token_hash, createHash('sha256').update(pat.token).digest('hex'));
  await f.restart();
  assert.equal((await f.browser.request('/api/private')).status, 200);
  assert.ok(await f.auth.authenticateMcp(pat.token));
  const fakeUpgrade = { headers: { origin: f.base, cookie: [...f.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } };
  assert.equal(f.auth.authorizeUpgrade(fakeUpgrade as never), true);
  assert.equal(f.auth.authorizeUpgrade({ headers: { ...fakeUpgrade.headers, origin: 'https://attacker.invalid' } } as never), false);
  assert.equal((await f.browser.json(`/api/tokens/${pat.id}`, 'DELETE')).status, 200);
  assert.equal(await f.auth.authenticateMcp(pat.token), null);
  await f.browser.json('/api/logout', 'POST', {});
  assert.equal(f.auth.authorizeUpgrade(fakeUpgrade as never), false);
  assert.equal((await f.browser.request('/api/private')).status, 401);
  const wrongLogin = await f.browser.json('/api/login', 'POST', { username: 'owner', password: 'wrong' });
  assert.equal(wrongLogin.status, 401);
  assert.deepEqual(await wrongLogin.json(), { code: 'INVALID_CREDENTIALS', error: 'Incorrect username or password.' });
  assert.equal((await f.browser.json('/api/login', 'POST', { username: 'owner', password: 'correct-password' })).status, 200);
  assert.equal((await f.browser.json('/api/password', 'POST', { currentPassword: 'correct-password', newPassword: 'updated-password' })).status, 200);
  await f.browser.json('/api/logout', 'POST', {});
  assert.equal((await f.browser.json('/api/login', 'POST', { username: 'owner', password: 'correct-password' })).status, 401);
  assert.equal((await f.browser.json('/api/login', 'POST', { username: 'owner', password: 'updated-password' })).status, 200);
});

test('real OAuth DCR + PKCE authorization, refresh across restart, and grant/token revocation', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.setup();
  const resource = `${f.base}/mcp`;
  const metadata = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, resource);
  const discovery = await (await fetch(`${f.base}/oauth/.well-known/openid-configuration`)).json();
  assert.equal(discovery.issuer, `${f.base}/oauth`);
  assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
  const registration = await fetch(discovery.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Integration test', application_type: 'native', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json();
  async function authorization(scope = 'openid offline_access mcp') {
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: 'http://127.0.0.1:9876/callback', scope, resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'integration-state', prompt: 'consent' }).toString();
    let page = await f.browser.follow(await f.browser.request(url.href));
    assert.equal(page.callback, undefined, page.callback?.href);
    let html = await page.response.text();
    const loginAction = html.match(/action="([^"]+\/login)"/)?.[1];
    if (loginAction) {
      const loginCsrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      assert.ok(loginCsrf);
      const login = await f.browser.request(loginAction, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: f.base }, body: new URLSearchParams({ csrf: loginCsrf, username: 'owner', password: 'correct-password' }) });
      page = await f.browser.follow(login);
      assert.equal(page.callback, undefined);
      html = await page.response.text();
    }
    assert.match(html, /127\.0\.0\.1:9876/, 'consent shows where tokens go');
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    const action = html.match(/action="([^"]+\/confirm)"/)?.[1];
    assert.ok(csrf && action, html);
    const confirmed = await f.browser.request(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: f.base }, body: new URLSearchParams({ csrf, decision: 'allow' }) });
    const finished = await f.browser.follow(confirmed);
    assert.ok(finished.callback, await finished.response.text());
    assert.equal(finished.callback.searchParams.get('error'), null, finished.callback.href);
    assert.equal(finished.callback.searchParams.get('state'), 'integration-state');
    const code = finished.callback.searchParams.get('code');
    assert.ok(code);
    return { code, verifier };
  }
  const tokenRequest = (body: Record<string, string>) => fetch(discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, ...body }) });
  await f.browser.json('/api/logout', 'POST', {});
  const first = await authorization();
  const wrongPkce = await tokenRequest({ grant_type: 'authorization_code', code: first.code, code_verifier: 'a'.repeat(43), redirect_uri: 'http://127.0.0.1:9876/callback', resource });
  assert.equal(wrongPkce.status, 400);
  const second = await authorization();
  const exchange = await tokenRequest({ grant_type: 'authorization_code', code: second.code, code_verifier: second.verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await f.auth.authenticateMcp(tokens.access_token))?.subject, 'admin');
  const replayCode = await tokenRequest({ grant_type: 'authorization_code', code: second.code, code_verifier: second.verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource });
  assert.equal(replayCode.status, 400);
  // Reusing an authorization code can revoke its grant; acquire a fresh grant for restart checks.
  const third = await authorization();
  const fresh = await tokenRequest({ grant_type: 'authorization_code', code: third.code, code_verifier: third.verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource });
  assert.equal(fresh.status, 200, await fresh.clone().text());
  const beforeRestart = await fresh.json();
  const jwksBefore = await (await fetch(discovery.jwks_uri)).json();
  await f.restart();
  assert.deepEqual(await (await fetch(discovery.jwks_uri)).json(), jwksBefore);
  assert.ok(await f.auth.authenticateMcp(beforeRestart.access_token));
  // A grant about to expire is extended by an active refresh chain.
  const soon = Math.floor(Date.now() / 1000) + 60;
  f.db.prepare("UPDATE auth_oauth SET expires_at=?, payload=json_set(payload,'$.exp',?) WHERE model='Grant'").run(soon, soon);
  const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: beforeRestart.refresh_token, resource });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const renewed = await refresh.json();
  const grantExpiry = () => (f.db.prepare("SELECT max(expires_at) e FROM auth_oauth WHERE model='Grant'").get() as { e: number }).e;
  for (let i = 0; i < 50 && grantExpiry() <= soon; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(grantExpiry() > soon + 29 * 86400, 'grant extended on refresh');
  assert.ok(renewed.access_token && renewed.refresh_token);
  assert.notEqual(renewed.refresh_token, beforeRestart.refresh_token);
  assert.ok(await f.auth.authenticateMcp(renewed.access_token));
  const grants = await (await f.browser.request('/api/oauth/grants')).json();
  assert.ok(grants.length >= 1);
  assert.equal(grants[0].clientName, 'Integration test');
  for (const grant of grants) assert.equal((await f.browser.json(`/api/oauth/grants/${grant.id}`, 'DELETE')).status, 200);
  assert.equal(await f.auth.authenticateMcp(renewed.access_token), null);
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token, resource })).status, 400);
  // Without offline_access the refresh token still outlives the login session.
  const sessionless = await authorization('openid mcp');
  const sessionlessTokens = await (await tokenRequest({ grant_type: 'authorization_code', code: sessionless.code, code_verifier: sessionless.verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource })).json();
  assert.ok(sessionlessTokens.refresh_token);
  f.db.prepare("DELETE FROM auth_oauth WHERE model='Session'").run();
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: sessionlessTokens.refresh_token, resource })).status, 200);
  const fourth = await authorization();
  const finalExchange = await tokenRequest({ grant_type: 'authorization_code', code: fourth.code, code_verifier: fourth.verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource });
  assert.equal(finalExchange.status, 200, await finalExchange.clone().text());
  const last = await finalExchange.json();
  assert.ok(await f.auth.authenticateMcp(last.access_token));
  const revoked = await fetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, token: last.refresh_token, token_type_hint: 'refresh_token' }) });
  assert.equal(revoked.status, 200, await revoked.text());
  assert.equal(await f.auth.authenticateMcp(last.access_token), null);
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: last.refresh_token, resource })).status, 400);
});

test('login limit groups IPv6 clients by /64 network', () => {
  const key = (ip: string) => loginKey({ ip, socket: {} as never });
  assert.equal(key('203.0.113.7'), '203.0.113.7');
  assert.equal(key('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(key('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(key('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(key('2001:db8::5%eth0'), '2001:db8:0:0::/64');
  assert.notEqual(key('2001:db8:1:3::1'), key('2001:db8:1:2::1'));
});

test('dynamic client registration is rate limited per address', async (t) => {
  const f = await fixture(); t.after(f.close);
  const discovery = await (await fetch(`${f.base}/oauth/.well-known/openid-configuration`)).json();
  const register = (address: string) => fetch(discovery.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
    body: JSON.stringify({ client_name: 'Flood', application_type: 'native', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none' }),
  });
  for (let n = 0; n < 20; n++) assert.equal((await register('198.51.100.1')).status, 201);
  const limited = await register('198.51.100.1');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'REGISTRATION_RATE_LIMITED');
  assert.equal((await register('198.51.100.2')).status, 201, 'other addresses are not affected');
});

test('wrong logins from many addresses share an overall limit', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.setup();
  for (let n = 0; n < 10; n++) {
    const results = await Promise.all(Array.from({ length: 10 }, () => f.browser.json('/api/login', 'POST', { username: 'owner', password: 'wrong' }, { 'X-Forwarded-For': `198.51.100.${n}` })));
    assert.ok(results.every(response => response.status === 401));
  }
  const blocked = await f.browser.json('/api/login', 'POST', { username: 'owner', password: 'correct-password' }, { 'X-Forwarded-For': '198.51.100.200' });
  assert.equal(blocked.status, 429);
});

test('concurrent wrong logins cannot exceed the attempt limit', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.setup();
  const results = await Promise.all(Array.from({ length: 14 }, () => f.browser.json('/api/login', 'POST', { username: 'owner', password: 'wrong' })));
  assert.equal(results.filter(response => response.status === 401).length, 10);
  assert.equal(results.filter(response => response.status === 429).length, 4);
});

test('setup token location is logged while no administrator exists, never the token', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logged.push(args.join(' ')); });
  const f = await fixture(); t.after(f.close);
  const tokenPath = path.join(f.dir, 'setup-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  assert.deepEqual(logged.filter(line => line.startsWith('Hostherd setup token')),
    [`Hostherd setup token saved to ${tokenPath}; it is removed after the first administrator is created`]);
  await f.restart();
  assert.equal(logged.filter(line => line.startsWith('Hostherd setup token')).length, 2);
  assert.equal(logged.filter(line => line.includes(token)).length, 0, 'the token itself is never logged');
  assert.equal((await readFile(tokenPath, 'utf8')).trim(), token, 'a restart keeps the same token');
  await f.setup();
  await f.restart();
  assert.equal(logged.filter(line => line.startsWith('Hostherd setup token')).length, 2);
});

test('OAuth pages follow Accept-Language and keep the redirect warning in both languages', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.setup();
  const discovery = await (await fetch(`${f.base}/oauth/.well-known/openid-configuration`)).json();
  const client = await (await fetch(discovery.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Language test', application_type: 'native', redirect_uris: ['http://127.0.0.1:9876/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })).json();
  const authorize = async (browser: Browser, language?: string) => {
    browser.headers = language ? { 'Accept-Language': language } : {};
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: 'http://127.0.0.1:9876/callback', scope: 'openid mcp', resource: `${f.base}/mcp`, code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' }).toString();
    return (await browser.follow(await browser.request(url.href))).response.text();
  };
  const korean = await authorize(f.browser, 'ko-KR,ko;q=0.9,en;q=0.8');
  assert.match(korean, /<html lang="ko">/);
  assert.match(korean, /MCP 연결 승인/);
  assert.match(korean, /직접 연결 중인 앱의 주소가 아니면 취소하세요/);
  assert.match(korean, /127\.0\.0\.1:9876/);
  const english = await authorize(f.browser, 'en-US,en;q=0.9');
  assert.match(english, /<html lang="en">/);
  assert.match(english, /Approve MCP connection/);
  assert.match(english, /Cancel unless this is the address of the app you are connecting/);
  assert.match(english, /127\.0\.0\.1:9876/);
  const anonymous = new Browser(f.base);
  assert.match(await authorize(anonymous, 'fr-FR,fr;q=0.9'), /<html lang="en">[\s\S]*Hostherd administrator login/);
  assert.match(await authorize(anonymous), /<html lang="en">/);
  assert.match(await authorize(anonymous, 'ko'), /<html lang="ko">[\s\S]*Hostherd 관리자 로그인/);
});
