import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type Database from 'better-sqlite3';
import express, { type Request, type RequestHandler, type Response } from 'express';
import Provider, { errors, type Configuration } from 'oidc-provider';
import { createOAuthAdapter } from './oauth-adapter.js';

const SESSION_COOKIE = 'hostherd_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
// A connection lives while its refresh token is used: each refresh issues a 30-day token and extends the grant.
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const SUBJECT = 'admin';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** API errors are `{ code, error }` with an English message; the web localizes by code. */
const fail = (res: Response, status: number, code: string, error: string) => { res.status(status).json({ code, error }); };

type Lang = 'en' | 'ko';
/** Server-rendered OAuth pages follow the browser's Accept-Language: Korean when preferred, English otherwise. */
const pageLanguage = (req: Request): Lang => req.acceptsLanguages('en', 'ko') === 'ko' ? 'ko' : 'en';
const PAGE_TEXT = {
  en: {
    setupTitle: 'Setup required', setupBody: 'Set up the administrator account in the Hostherd web console first.',
    loginTitle: 'Hostherd administrator login', loginBody: 'Log in to approve the MCP connection.', username: 'Username', password: 'Password', login: 'Log in',
    consentTitle: 'Approve MCP connection',
    consentBody: (client: string) => `<p><strong>${client}</strong> will be allowed to run commands and access files on all registered servers. The app chose this name itself.</p>`,
    redirectWarning: 'If you allow, the access token is sent to the address below.', redirectCheck: 'Cancel unless this is the address of the app you are connecting.',
    registered: 'App registered', allow: 'Allow connection', cancel: 'Cancel',
    loginFailedTitle: 'Login failed', loginFailed: 'Incorrect username or password.', retry: 'Log in again', rateLimited: 'Too many login attempts. Try again later.',
  },
  ko: {
    setupTitle: '초기 설정이 필요합니다', setupBody: '먼저 Hostherd 웹 화면에서 관리자 계정을 설정해 주세요.',
    loginTitle: 'Hostherd 관리자 로그인', loginBody: 'MCP 연결을 승인하려면 로그인해 주세요.', username: '사용자 이름', password: '비밀번호', login: '로그인',
    consentTitle: 'MCP 연결 승인',
    consentBody: (client: string) => `<p><strong>${client}</strong>에 모든 등록 서버의 명령 실행과 파일 접근을 허용합니다. 앱 이름은 앱이 직접 정한 값입니다.</p>`,
    redirectWarning: '허용하면 접근 토큰이 아래 주소로 전달됩니다.', redirectCheck: '직접 연결 중인 앱의 주소가 아니면 취소하세요.',
    registered: '앱 등록', allow: '연결 허용', cancel: '취소',
    loginFailedTitle: '로그인 실패', loginFailed: '사용자 이름 또는 비밀번호가 올바르지 않습니다.', retry: '다시 로그인', rateLimited: '잠시 후 다시 로그인해 주세요.',
  },
} satisfies Record<Lang, unknown>;

function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

async function passwordHash(password: string, salt = randomBytes(16).toString('hex')): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result)));
  return `${salt}:${key.toString('hex')}`;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

type Admin = { username: string; password_hash: string };
type Session = { username: string; expires_at: number };
type TokenIdentity = { subject: string; clientId: string; scopes: string[] };

export async function createAuth({ db, app, publicUrl, dataDir }: {
  db: Database.Database; app: express.Express; publicUrl: string; dataDir: string;
}): Promise<{
  requireAdmin: RequestHandler;
  authenticateMcp: (token: string) => Promise<TokenIdentity | null>;
  authorizeUpgrade: (req: IncomingMessage) => boolean;
  /** A valid admin session cookie, for requests browsers send without Origin (event streams). */
  hasSession: (req: IncomingMessage) => boolean;
  clientLabel: (clientId: string) => string | null;
  close: () => void;
}> {
  publicUrl = publicUrl.replace(/\/$/, '');
  const publicOrigin = new URL(publicUrl).origin;
  const secure = new URL(publicUrl).protocol === 'https:';
  const issuer = `${publicUrl}/oauth`;
  const resource = `${publicUrl}/mcp`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_pats (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT);
    CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const admin = () => db.prepare('SELECT username,password_hash FROM auth_admin WHERE id=1').get() as Admin | undefined;
  const persistent = (key: string, make: () => string) => {
    const stored = db.prepare('SELECT value FROM auth_kv WHERE key=?').get(key) as { value: string } | undefined;
    if (stored) return stored.value;
    const value = make();
    db.prepare('INSERT INTO auth_kv(key,value) VALUES(?,?)').run(key, value);
    return value;
  };
  const cookieKey = persistent('oauth_cookie_key', secret);
  const jwks = JSON.parse(persistent('oauth_jwks', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' }] });
  }));

  const setupPath = path.join(dataDir, 'setup-token');
  let setupToken: string | null = null;
  if (!admin()) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try { setupToken = (await readFile(setupPath, 'utf8')).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!setupToken) {
      setupToken = secret();
      await writeFile(setupPath, `${setupToken}\n`, { mode: 0o600 });
    }
    await chmod(setupPath, 0o600);
    // Container installs read it from the log; the file stays for shell access.
    console.log(`Hostherd setup token: ${setupToken} (also saved to ${setupPath}; it is removed after the first administrator is created)`);
  }

  function session(req: IncomingMessage): Session | undefined {
    const token = cookie(req, SESSION_COOKIE);
    if (!token) return undefined;
    const row = db.prepare(`SELECT a.username,s.expires_at FROM auth_sessions s CROSS JOIN auth_admin a
      WHERE s.token_hash=? AND s.expires_at>? AND a.id=1`).get(hash(token), Date.now()) as Session | undefined;
    return row;
  }
  function newSession(res: Response) {
    const token = secret();
    db.prepare('INSERT INTO auth_sessions(token_hash,expires_at) VALUES(?,?)').run(hash(token), Date.now() + SESSION_SECONDS * 1000);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_SECONDS * 1000 });
  }
  function validOrigin(req: IncomingMessage): boolean {
    return req.headers.origin ? req.headers.origin === publicOrigin : req.headers['sec-fetch-site'] !== 'cross-site';
  }
  const protectWrite: RequestHandler = (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validOrigin(req)) { fail(res, 403, 'INVALID_ORIGIN', 'The request origin is not allowed.'); return; }
    next();
  };
  const requireAdmin: RequestHandler = (req, res, next) => {
    if (!session(req)) { fail(res, 401, 'LOGIN_REQUIRED', 'Administrator login is required.'); return; }
    protectWrite(req, res, next);
  };
  const failures = new Map<string, { count: number; until: number }>();
  const loginAllowed = (req: Request) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const current = failures.get(key);
    if (current && current.until > Date.now() && current.count >= 10) return false;
    return true;
  };
  async function checkLogin(req: Request, username: unknown, password: unknown): Promise<boolean> {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    // Count the attempt before hashing, so concurrent requests cannot pass the limit together.
    const previous = failures.get(key);
    const active = previous && previous.until > Date.now();
    failures.set(key, { count: active ? previous.count + 1 : 1, until: active ? previous.until : Date.now() + 5 * 60_000 });
    const account = admin();
    let valid = false;
    if (account && typeof username === 'string' && typeof password === 'string' && password.length <= 1024) {
      const computed = await passwordHash(password, account.password_hash.split(':')[0]);
      valid = equal(username, account.username) && equal(computed, account.password_hash);
    }
    if (valid) failures.delete(key);
    return valid;
  }

  const adapter = createOAuthAdapter(db);
  const configuration: Configuration = {
    adapter, jwks,
    cookies: { keys: [cookieKey], long: { signed: true, sameSite: 'lax' }, short: { signed: true, sameSite: 'lax' } },
    claims: { openid: ['sub'] },
    scopes: ['openid', 'offline_access', 'mcp'],
    responseTypes: ['code'],
    clientDefaults: { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    pkce: { required: () => true },
    ttl: { AccessToken: 3600, IdToken: 3600, AuthorizationCode: 300, RefreshToken: REFRESH_SECONDS, Grant: REFRESH_SECONDS, Session: SESSION_SECONDS, Interaction: 600 },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    // Refresh tokens are issued without offline_access too; do not tie them to the 7-day login session.
    expiresWithSession: () => false,
    rotateRefreshToken: true,
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget('Unknown resource');
          return { scope: 'mcp', audience: resource, accessTokenTTL: 3600, accessTokenFormat: 'opaque' };
        },
      },
    },
    findAccount: (_ctx, id) => id === SUBJECT && admin() ? { accountId: SUBJECT, claims: () => ({ sub: SUBJECT }) } : undefined,
    interactions: { url: (_ctx, interaction) => `${issuer}/interaction/${interaction.uid}` },
  };
  const provider = new Provider(issuer, configuration);
  // Express is behind the configured HTTPS reverse proxy in production.
  provider.proxy = secure;
  // oidc-provider keeps the grant's original expiry on refresh; extend it so an active connection does not end 30 days after consent.
  provider.on('refresh_token.saved', (token: { grantId?: string }) => {
    if (!token.grantId) return;
    void provider.Grant.find(token.grantId).then(async grant => {
      if (!grant) return;
      grant.exp = Math.floor(Date.now() / 1000) + REFRESH_SECONDS;
      await grant.save();
    }).catch(() => undefined);
  });

  const api = express.Router();
  api.use(['/me', '/setup', '/login', '/logout', '/password', '/tokens', '/oauth/grants'],
    express.json({ limit: '32kb' }), protectWrite,
    (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.get('/me', (req, res) => {
    const current = session(req);
    res.set('Cache-Control', 'no-store').json({ authenticated: !!current, ...(current ? { username: current.username } : {}), setupRequired: !admin() });
  });
  api.post('/setup', async (req, res) => {
    if (admin()) { fail(res, 409, 'ADMIN_EXISTS', 'An administrator is already set up.'); return; }
    const { username, password, setupToken: provided } = req.body ?? {};
    if (typeof provided !== 'string' || !setupToken || !equal(provided.trim(), setupToken)) { fail(res, 403, 'INVALID_SETUP_TOKEN', 'The setup token is incorrect.'); return; }
    if (typeof username !== 'string' || !username.trim() || username.length > 80 || typeof password !== 'string' || password.length < 8 || password.length > 1024) {
      fail(res, 400, 'INVALID_SETUP_INPUT', 'Enter a username and a password of at least 8 characters.'); return;
    }
    const encoded = await passwordHash(password);
    const changed = db.prepare('INSERT OR IGNORE INTO auth_admin(id,username,password_hash) VALUES(1,?,?)').run(username.trim(), encoded).changes;
    if (!changed) { fail(res, 409, 'ADMIN_EXISTS', 'An administrator is already set up.'); return; }
    setupToken = null;
    await unlink(setupPath).catch(() => undefined);
    newSession(res);
    res.status(201).json({ authenticated: true, username: username.trim() });
  });
  api.post('/login', async (req, res) => {
    if (!loginAllowed(req)) { fail(res, 429, 'LOGIN_RATE_LIMITED', 'Too many login attempts. Try again later.'); return; }
    if (!await checkLogin(req, req.body?.username, req.body?.password)) { fail(res, 401, 'INVALID_CREDENTIALS', 'Incorrect username or password.'); return; }
    newSession(res);
    res.json({ authenticated: true, username: admin()!.username });
  });
  api.post('/logout', (req, res) => {
    const token = cookie(req, SESSION_COOKIE);
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));
    res.clearCookie(SESSION_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  });
  api.post('/password', requireAdmin, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!loginAllowed(req)) { fail(res, 429, 'PASSWORD_RATE_LIMITED', 'Too many attempts. Try again later.'); return; }
    if (!await checkLogin(req, admin()!.username, currentPassword)) { fail(res, 403, 'INVALID_PASSWORD', 'The current password is incorrect.'); return; }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 1024) { fail(res, 400, 'INVALID_NEW_PASSWORD', 'Enter a password of at least 8 characters.'); return; }
    db.prepare('UPDATE auth_admin SET password_hash=? WHERE id=1').run(await passwordHash(newPassword));
    db.prepare('DELETE FROM auth_sessions').run();
    newSession(res);
    res.json({ ok: true });
  });
  api.get('/tokens', requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt FROM auth_pats ORDER BY created_at DESC').all());
  });
  api.post('/tokens', requireAdmin, (req, res) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) { fail(res, 400, 'INVALID_TOKEN_NAME', 'Enter a token name.'); return; }
    const expiresAt = req.body?.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) { fail(res, 400, 'INVALID_TOKEN_EXPIRY', 'The expiry time is invalid.'); return; }
    const id = randomUUID(), token = `hostherd_${secret()}`, createdAt = new Date().toISOString();
    db.prepare('INSERT INTO auth_pats(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, name.trim(), hash(token), createdAt, expiresAt);
    res.status(201).json({ id, name: name.trim(), token, createdAt, expiresAt });
  });
  api.delete('/tokens/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM auth_pats WHERE id=?').run(String(req.params.id));
    res.json({ ok: true });
  });
  api.get('/oauth/grants', requireAdmin, (_req, res) => {
    const rows = db.prepare("SELECT id,payload,expires_at FROM auth_oauth WHERE model='Grant' AND (expires_at IS NULL OR expires_at>?)").all(Math.floor(Date.now() / 1000)) as { id: string; payload: string; expires_at: number | null }[];
    res.json(rows.map((row) => {
      const grant = JSON.parse(row.payload);
      const client = db.prepare("SELECT payload FROM auth_oauth WHERE model='Client' AND id=?").get(grant.clientId) as { payload: string } | undefined;
      const metadata = client ? JSON.parse(client.payload) : {};
      return { id: row.id, clientId: grant.clientId, clientName: metadata.client_name ?? grant.clientId, expiresAt: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null };
    }));
  });
  api.delete('/oauth/grants/:id', requireAdmin, async (req, res) => {
    await new adapter('Grant').revokeByGrantId(String(req.params.id));
    res.json({ ok: true });
  });
  app.use('/api', api);

  const metadata = (_req: Request, res: Response) => res.json({ resource, authorization_servers: [issuer], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'Hostherd' });
  app.get('/.well-known/oauth-protected-resource', metadata);
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);
  // RFC 8414 path-based issuer discovery, in addition to the provider's OIDC endpoint.
  app.get('/.well-known/oauth-authorization-server/oauth', (_req, res) => res.redirect(302, `${issuer}/.well-known/oauth-authorization-server`));

  function page(res: Response, lang: Lang, title: string, body: string, redirectUri?: unknown) {
    // Chrome applies form-action to redirects after the same-origin form POST as well.
    // interactionDetails has already validated this request's registered redirect URI.
    const callback = typeof redirectUri === 'string' ? new URL(redirectUri) : undefined;
    const callbackSource = callback ? ` ${callback.origin === 'null' ? callback.protocol : callback.origin}` : '';
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackSource}; frame-ancestors 'none'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff' });
    res.type('html').send(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Hostherd</title><style>body{font:16px system-ui;background:#f6f7f9;color:#172033;display:grid;min-height:95vh;place-items:center;margin:0}main{background:white;border:1px solid #e5e7eb;border-radius:16px;padding:32px;max-width:420px;width:calc(100% - 96px)}h1{font-size:24px}label{display:block;margin:16px 0}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px;border:1px solid #ccd2da;border-radius:8px}input{margin-top:6px}button{background:#172033;color:white;cursor:pointer;margin-top:12px}p{line-height:1.6}.secondary{background:white;color:#172033}.warn{background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:4px 16px}.host{font-size:20px;font-weight:700;word-break:break-all}.note{color:#5b6475;font-size:13px;word-break:break-all}</style><main><h1>${escapeHtml(title)}</h1>${body}</main></html>`);
  }
  const csrf = (uid: string) => createHmac('sha256', cookieKey).update(uid).digest('base64url');
  const interaction = express.Router();
  interaction.use(express.urlencoded({ extended: false, limit: '16kb' }), protectWrite);
  interaction.get('/:uid', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const uid = String(req.params.uid);
    const authenticated = session(req);
    const lang = pageLanguage(req), t = PAGE_TEXT[lang];
    if (!admin()) { res.status(503); page(res, lang, t.setupTitle, `<p>${t.setupBody}</p>`); return; }
    if (details.prompt.name === 'login' && authenticated) {
      await provider.interactionFinished(req, res, { login: { accountId: SUBJECT } }, { mergeWithLastSubmission: false }); return;
    }
    const hidden = `<input type="hidden" name="csrf" value="${csrf(uid)}">`;
    if (!authenticated) {
      page(res, lang, t.loginTitle, `<p>${t.loginBody}</p><form method="post" action="${issuer}/interaction/${escapeHtml(uid)}/login">${hidden}<label>${t.username}<input name="username" autocomplete="username" required></label><label>${t.password}<input name="password" type="password" autocomplete="current-password" required></label><button>${t.login}</button></form>`, details.params.redirect_uri);
      return;
    }
    const client = await provider.Client.find(String(details.params.client_id));
    const callback = new URL(String(details.params.redirect_uri));
    const registered = client?.clientIdIssuedAt ? `<p class="note">${t.registered}: ${new Date(client.clientIdIssuedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>` : '';
    page(res, lang, t.consentTitle, `${t.consentBody(escapeHtml(client?.clientName ?? details.params.client_id))}<div class="warn"><p>${t.redirectWarning}</p><p class="host">${escapeHtml(callback.host || callback.protocol)}</p><p class="note">${escapeHtml(callback.href)}</p><p>${t.redirectCheck}</p></div>${registered}<form method="post" action="${issuer}/interaction/${escapeHtml(uid)}/confirm">${hidden}<button name="decision" value="allow">${t.allow}</button><button class="secondary" name="decision" value="deny">${t.cancel}</button></form>`, details.params.redirect_uri);
  });
  interaction.post('/:uid/login', async (req, res) => {
    await provider.interactionDetails(req, res);
    if (!equal(String(req.body?.csrf ?? ''), csrf(String(req.params.uid)))) { res.status(403).send('Invalid request'); return; }
    const lang = pageLanguage(req), t = PAGE_TEXT[lang];
    if (!loginAllowed(req)) { res.status(429).type('text').send(t.rateLimited); return; }
    if (!await checkLogin(req, req.body?.username, req.body?.password)) { res.status(401); page(res, lang, t.loginFailedTitle, `<p>${t.loginFailed}</p><a href="${issuer}/interaction/${escapeHtml(req.params.uid)}">${t.retry}</a>`); return; }
    newSession(res);
    await provider.interactionFinished(req, res, { login: { accountId: SUBJECT } }, { mergeWithLastSubmission: false });
  });
  interaction.post('/:uid/confirm', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (!session(req) || !equal(String(req.body?.csrf ?? ''), csrf(String(req.params.uid)))) { res.status(403).send('Invalid request'); return; }
    if (req.body.decision !== 'allow') { await provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'Administrator declined access' }, { mergeWithLastSubmission: false }); return; }
    if (details.prompt.name !== 'consent') { res.status(400).send('Unexpected interaction'); return; }
    const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: SUBJECT, clientId: String(details.params.client_id) });
    if (!grant) { res.status(400).send('Grant expired'); return; }
    const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[]; missingResourceScopes?: Record<string, string[]> };
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
    for (const [target, scopes] of Object.entries(missing.missingResourceScopes ?? {})) grant.addResourceScope(target, scopes.join(' '));
    await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
  });
  app.use('/oauth/interaction', interaction);
  // Mount before any application-wide JSON/urlencoded parsers: provider parses OAuth request bodies itself.
  app.use('/oauth', provider.callback());

  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('DELETE FROM auth_oauth WHERE expires_at IS NOT NULL AND expires_at<=?').run(Math.floor(Date.now() / 1000));
    for (const [key, entry] of failures) if (entry.until <= Date.now()) failures.delete(key);
  }, 60_000);
  cleanup.unref();

  return {
    requireAdmin,
    authorizeUpgrade: (req) => req.headers.origin === publicOrigin && !!session(req),
    hasSession: (req) => !!session(req),
    clientLabel: (clientId: string): string | null => {
      if (clientId.startsWith('pat:')) return (db.prepare('SELECT name FROM auth_pats WHERE id=?').get(clientId.slice(4)) as { name: string } | undefined)?.name ?? null;
      const client = db.prepare("SELECT payload FROM auth_oauth WHERE model='Client' AND id=?").get(clientId) as { payload: string } | undefined;
      return client ? JSON.parse(client.payload).client_name ?? null : null;
    },
    authenticateMcp: async (token) => {
      if (!token || token.length > 16_384) return null;
      if (token.startsWith('hostherd_')) {
        const pat = db.prepare('SELECT id,expires_at FROM auth_pats WHERE token_hash=?').get(hash(token)) as { id: string; expires_at: string | null } | undefined;
        if (!pat || (pat.expires_at !== null && Date.parse(pat.expires_at) <= Date.now())) return null;
        db.prepare('UPDATE auth_pats SET last_used_at=? WHERE id=?').run(new Date().toISOString(), pat.id);
        return { subject: SUBJECT, clientId: `pat:${pat.id}`, scopes: ['mcp'] };
      }
      try {
        const access = await provider.AccessToken.find(token);
        if (!access || access.accountId !== SUBJECT || access.aud !== resource || !access.grantId || !await provider.Grant.find(access.grantId)) return null;
        const scopes = (access.scope ?? '').split(' ');
        if (!scopes.includes('mcp')) return null;
        return { subject: SUBJECT, clientId: access.clientId!, scopes };
      } catch { return null; }
    },
    close: () => clearInterval(cleanup),
  };
}
