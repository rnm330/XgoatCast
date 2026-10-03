import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { QQ_CODE, qqAdmin, type QqEvent } from './qq-protocol';

export interface QqDelivery {
  key: string;
  group: string;
  body: Record<string, any>;
  replyUntil?: number;
  sessionId?: string;
  kind?: string;
}

@Injectable()
export class QqRepository {
  private get sql() { return this.db.integrationDatabase; }
  constructor(private readonly db: DatabaseService) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS qq_binding_intents (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
        epoch TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qq_binding_space ON qq_binding_intents(space_id);
      CREATE TABLE IF NOT EXISTS qq_binding_claims (
        id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES qq_binding_intents(id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL, code TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
        confirmer TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qq_events (
        key TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qq_events_pending ON qq_events(state, next_at);
      CREATE TABLE IF NOT EXISTS qq_outbox (
        key TEXT PRIMARY KEY, group_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, first_at INTEGER, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qq_outbox_pending ON qq_outbox(state, next_at);
      CREATE TABLE IF NOT EXISTS qq_group_state (
        group_id TEXT PRIMARY KEY, membership_at INTEGER NOT NULL DEFAULT 0,
        membership_state TEXT NOT NULL DEFAULT 'unknown',
        push_enabled INTEGER, last_all_message_at INTEGER, last_at_message_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS qq_session_reply (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qq_status (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // A process can die after QQ accepted an outgoing message. Passive replies
    // can be retried with their frozen msg_id/seq; proactive sends cannot.
    for (const row of this.sql.prepare("SELECT * FROM qq_outbox WHERE state='sending'").all() as any[]) {
      const job = JSON.parse(row.payload) as QqDelivery;
      const safe = !!job.body.msg_id && (job.replyUntil || 0) > Date.now();
      this.sql.prepare('UPDATE qq_outbox SET state=?, error=? WHERE key=?')
        .run(safe ? 'pending' : 'uncertain', 'process_interrupted', row.key);
    }
  }

  setStatus(key: string, value: unknown) {
    this.sql.prepare('INSERT OR REPLACE INTO qq_status VALUES (?, ?)').run(key, JSON.stringify(value));
  }
  status() {
    const stats = Object.fromEntries((this.sql.prepare('SELECT * FROM qq_status').all() as any[])
      .map(r => [r.key, JSON.parse(r.value)]));
    return { ...stats,
      groups: this.sql.prepare('SELECT * FROM qq_group_state').all(),
      events: this.sql.prepare('SELECT state, COUNT(*) AS count FROM qq_events GROUP BY state').all(),
      delivery: this.sql.prepare('SELECT state, COUNT(*) AS count FROM qq_outbox GROUP BY state').all(),
    };
  }

  observe(group: string, type: string) {
    this.sql.prepare('INSERT OR IGNORE INTO qq_group_state(group_id) VALUES (?)').run(group);
    if (type === 'GROUP_MESSAGE_CREATE') this.sql.prepare('UPDATE qq_group_state SET last_all_message_at=? WHERE group_id=?').run(Date.now(), group);
    if (type === 'GROUP_AT_MESSAGE_CREATE') this.sql.prepare('UPDATE qq_group_state SET last_at_message_at=? WHERE group_id=?').run(Date.now(), group);
  }
  membership(group: string, at: number, active: boolean): boolean {
    this.observe(group, '');
    return this.sql.prepare(`UPDATE qq_group_state SET membership_at=?, membership_state=?
      WHERE group_id=? AND (membership_at < ? OR (membership_at=? AND ?=0))`)
      .run(at, active ? 'active' : 'removed', group, at, at, active ? 1 : 0).changes === 1;
  }
  acceptsMessage(group: string, at: number): boolean {
    const row = this.sql.prepare('SELECT * FROM qq_group_state WHERE group_id=?').get(group) as any;
    return row?.membership_state !== 'removed' && (!row || at >= row.membership_at);
  }
  push(group: string, enabled: boolean) {
    this.observe(group, '');
    this.sql.prepare('UPDATE qq_group_state SET push_enabled=? WHERE group_id=?').run(enabled ? 1 : 0, group);
  }
  canPush(group: string) {
    const row = this.sql.prepare('SELECT push_enabled FROM qq_group_state WHERE group_id=?').get(group) as any;
    return row?.push_enabled !== 0;
  }

  intent(group: string) {
    const space = this.db.getSpace('qq', group);
    if (!space || space.bound || space.status !== 'active') return;
    const existing = this.sql.prepare('SELECT id FROM qq_binding_intents WHERE space_id=? AND epoch=? AND expires_at>?')
      .get(space.serverId, space.serverSecret, Date.now()) as any;
    if (existing) return existing.id as string;
    this.sql.prepare('DELETE FROM qq_binding_intents WHERE space_id=?').run(space.serverId);
    const id = randomBytes(24).toString('base64url');
    this.sql.prepare('INSERT INTO qq_binding_intents VALUES (?, ?, ?, ?)')
      .run(id, space.serverId, space.serverSecret, Date.now() + 10 * 60_000);
    return id;
  }
  getIntent(group: string, id: string): any {
    return this.sql.prepare(`SELECT i.*, s.guild_name FROM qq_binding_intents i
      JOIN servers s ON s.server_id=i.space_id WHERE i.id=? AND s.platform='qq' AND s.external_id=?
      AND s.status='active' AND s.bound=0 AND s.server_secret=i.epoch AND i.expires_at>?`)
      .get(id, group, Date.now());
  }
  claim(group: string, intentId: string, hash: string): any {
    if (!/^[a-f0-9]{64}$/.test(hash)) return;
    return this.sql.transaction(() => {
      const intent = this.getIntent(group, intentId);
      if (!intent || this.sql.prepare("SELECT 1 FROM qq_binding_claims WHERE intent_id=? AND state='authorized' AND expires_at>?").get(intentId, Date.now())) return;
      const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      for (let i = 0; i < 20; i++) {
        const id = randomBytes(24).toString('base64url');
        const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
        const expires = Math.min(intent.expires_at, Date.now() + 5 * 60_000);
        const result = this.sql.prepare('INSERT OR IGNORE INTO qq_binding_claims(id,intent_id,secret_hash,code,expires_at) VALUES (?,?,?,?,?)')
          .run(id, intentId, hash, code, expires);
        if (result.changes) return this.getClaim(group, intentId, id, hash);
      }
    })();
  }
  getClaim(group: string, intentId: string, id: string, hash: string): any {
    if (!this.getIntent(group, intentId)) return;
    return this.sql.prepare('SELECT * FROM qq_binding_claims WHERE id=? AND intent_id=? AND secret_hash=? AND expires_at>?')
      .get(id, intentId, hash, Date.now());
  }
  authorize(group: string, code: string, user: string, role: string): boolean {
    if (!user || !qqAdmin(role) || !QQ_CODE.test(code)) return false;
    return this.sql.transaction(() => {
      const row = this.sql.prepare(`SELECT c.* FROM qq_binding_claims c JOIN qq_binding_intents i ON i.id=c.intent_id
        JOIN servers s ON s.server_id=i.space_id WHERE c.code=? AND s.external_id=? AND s.platform='qq'
        AND s.status='active' AND s.bound=0 AND s.server_secret=i.epoch AND i.expires_at>? AND c.expires_at>?
        AND c.state IN ('pending','authorized')`).get(code.toUpperCase(), group, Date.now(), Date.now()) as any;
      if (!row || (row.state === 'authorized' && row.confirmer !== user)) return false;
      this.sql.prepare("UPDATE qq_binding_claims SET state='revoked' WHERE intent_id=? AND id!=?").run(row.intent_id, row.id);
      this.sql.prepare("UPDATE qq_binding_claims SET state='authorized', confirmer=? WHERE id=?").run(user, row.id);
      return true;
    })();
  }
  consume(group: string, intentId: string, id: string, hash: string, password: string): boolean {
    return this.sql.transaction(() => {
      const claim = this.getClaim(group, intentId, id, hash);
      const intent = this.getIntent(group, intentId);
      if (!intent || claim?.state !== 'authorized' || !password) return false;
      this.db.updateServer(intent.space_id, { bound: 1, passwordHash: password,
        reboundAt: Date.now(), serverSecret: randomBytes(32).toString('hex'), bindToken: '', bindTokenExpires: 0 });
      this.sql.prepare('DELETE FROM qq_binding_intents WHERE space_id=?').run(intent.space_id);
      return true;
    })();
  }
  revoke(group: string) {
    const space = this.db.getSpace('qq', group);
    if (!space) return;
    this.db.kickServer(space.serverId);
    this.db.updateServer(space.serverId, { serverSecret: randomBytes(32).toString('hex'), bindToken: '', bindTokenExpires: 0 });
    this.sql.prepare('DELETE FROM qq_binding_intents WHERE space_id=?').run(space.serverId);
    this.sql.prepare("UPDATE qq_outbox SET state='cancelled', payload='{}' WHERE group_id=? AND state IN ('pending','sending')").run(group);
  }

  enqueue(event: QqEvent, key: string) {
    this.sql.prepare('INSERT OR IGNORE INTO qq_events(key,payload,created_at) VALUES (?,?,?)')
      .run(key, JSON.stringify(event), Date.now());
  }
  dueEvents(): any[] {
    return this.sql.prepare("SELECT * FROM qq_events WHERE state='pending' AND next_at<=? ORDER BY created_at, rowid LIMIT 20").all(Date.now());
  }
  processEvent(key: string, work: () => void) {
    this.sql.transaction(() => {
      if (!(this.sql.prepare("SELECT 1 FROM qq_events WHERE key=? AND state='pending'").get(key))) return;
      work();
      // Drop the command and binding code after processing; retain only dedup metadata.
      this.sql.prepare("UPDATE qq_events SET state='done', payload='{}' WHERE key=?").run(key);
    })();
  }
  failEvent(key: string, error: string) {
    this.sql.prepare("UPDATE qq_events SET state='failed', payload='{}', error=? WHERE key=?").run(error, key);
  }
  queue(job: QqDelivery) {
    this.sql.prepare('INSERT OR IGNORE INTO qq_outbox(key,group_id,payload,created_at) VALUES (?,?,?,?)')
      .run(job.key, job.group, JSON.stringify(job), Date.now());
  }
  dueDeliveries(): any[] {
    return this.sql.prepare("SELECT * FROM qq_outbox WHERE state='pending' AND next_at<=? ORDER BY created_at, rowid LIMIT 20").all(Date.now());
  }
  beginDelivery(job: QqDelivery) {
    this.sql.prepare("UPDATE qq_outbox SET state='sending', payload=?, attempts=attempts+1, first_at=COALESCE(first_at,?) WHERE key=?")
      .run(JSON.stringify(job), Date.now(), job.key);
  }
  finishDelivery(key: string, state = 'done', error = '') {
    this.sql.prepare("UPDATE qq_outbox SET state=?, error=?, payload='{}' WHERE key=?").run(state, error, key);
  }
  retryDelivery(key: string, error: string) {
    this.sql.prepare("UPDATE qq_outbox SET state='pending', next_at=?, error=? WHERE key=?").run(Date.now() + 10_000, error, key);
  }
  saveReply(sessionId: string, messageId: string, expires: number) {
    this.sql.prepare('INSERT OR REPLACE INTO qq_session_reply VALUES (?,?,?)').run(sessionId, messageId, expires);
  }
  reply(sessionId: string): any {
    return this.sql.prepare('SELECT * FROM qq_session_reply WHERE session_id=?').get(sessionId);
  }
  cleanup() {
    this.sql.prepare('DELETE FROM qq_binding_intents WHERE expires_at<?').run(Date.now());
    this.sql.prepare('DELETE FROM qq_events WHERE created_at<? AND state!=\'pending\'').run(Date.now() - 7 * 86400_000);
    this.sql.prepare('DELETE FROM qq_outbox WHERE created_at<? AND state NOT IN (\'pending\',\'sending\')').run(Date.now() - 7 * 86400_000);
  }
}

export const qqHash = (text: string) => createHash('sha256').update(text).digest('hex');
