import type Database from 'better-sqlite3';
import type { AdapterPayload } from 'oidc-provider';

/** oidc-provider's state is stored alongside the application's persistent SQLite data. */
export function createOAuthAdapter(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_oauth (
      model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      expires_at INTEGER, grant_id TEXT, user_code TEXT, uid TEXT,
      consumed INTEGER, PRIMARY KEY(model, id)
    );
    CREATE INDEX IF NOT EXISTS auth_oauth_grant ON auth_oauth(grant_id);
    CREATE INDEX IF NOT EXISTS auth_oauth_uid ON auth_oauth(model, uid);
    CREATE INDEX IF NOT EXISTS auth_oauth_user_code ON auth_oauth(model, user_code);
  `);

  type Row = { payload: string; expires_at: number | null; consumed: number | null };
  function decode(row: Row | undefined): AdapterPayload | undefined {
    if (!row || (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000))) return undefined;
    const payload = JSON.parse(row.payload) as AdapterPayload;
    if (row.consumed !== null) payload.consumed = row.consumed;
    return payload;
  }

  return class SQLiteOAuthAdapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      db.prepare(`INSERT INTO auth_oauth(model,id,payload,expires_at,grant_id,user_code,uid,consumed)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
        payload=excluded.payload, expires_at=excluded.expires_at, grant_id=excluded.grant_id,
        user_code=excluded.user_code, uid=excluded.uid, consumed=excluded.consumed`).run(
        this.model, id, JSON.stringify(payload),
        expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null,
        payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, payload.consumed ?? null,
      );
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return decode(db.prepare('SELECT * FROM auth_oauth WHERE model=? AND id=?').get(this.model, id) as Row | undefined);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return decode(db.prepare('SELECT * FROM auth_oauth WHERE model=? AND user_code=?').get(this.model, userCode) as Row | undefined);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return decode(db.prepare('SELECT * FROM auth_oauth WHERE model=? AND uid=?').get(this.model, uid) as Row | undefined);
    }

    async consume(id: string): Promise<void> {
      db.prepare('UPDATE auth_oauth SET consumed=? WHERE model=? AND id=?').run(Math.floor(Date.now() / 1000), this.model, id);
    }

    async destroy(id: string): Promise<void> {
      db.prepare('DELETE FROM auth_oauth WHERE model=? AND id=?').run(this.model, id);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      db.prepare('DELETE FROM auth_oauth WHERE grant_id=? OR (model=\'Grant\' AND id=?)').run(grantId, grantId);
    }
  };
}
