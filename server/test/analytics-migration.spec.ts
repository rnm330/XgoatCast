import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DatabaseService } from '../src/modules/database/database.service';

test('legacy server events are backfilled once without duplicating dual-written events', () => {
  const previousCwd = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'xgoatcast-analytics-migration-'));
  let service: DatabaseService | undefined;

  try {
    process.chdir(fixtureRoot);
    service = new DatabaseService();
    service.createServer('legacy-server', 'Legacy server', 'owner', 'Owner');
    service.onModuleDestroy();
    service = undefined;

    const dbPath = join(fixtureRoot, 'data', 'xgoatcast.db');
    let db = new Database(dbPath);
    const insertLegacy = db.prepare(`
      INSERT INTO server_events (
        server_id, event_type, operator_id, operator_name, detail, created_at
      ) VALUES ('legacy-server', ?, 'private-operator', 'Private name', ?, ?)
    `);
    const firstJoin = Number(insertLegacy.run('bot_joined', 'first join', 1_000).lastInsertRowid);
    const secondJoin = Number(insertLegacy.run('bot_joined', 'second join', 1_500).lastInsertRowid);
    const kicked = Number(insertLegacy.run('bot_kicked', 'removed', 2_000).lastInsertRowid);
    const dualWritten = Number(insertLegacy.run('bot_joined', 'dual write', 3_000).lastInsertRowid);
    db.prepare(`
      INSERT INTO analytics_server_events (
        event_key, server_snowflake_id, server_name,
        event_type, reason, occurred_at
      ) VALUES ('already-recorded', 'legacy-server', 'Legacy server',
                'bot_joined', '', 3005)
    `).run();
    db.close();

    service = new DatabaseService();
    service.onModuleDestroy();
    service = undefined;

    db = new Database(dbPath);
    const rows = db.prepare(`
      SELECT event_key, event_type, reason
      FROM analytics_server_events
      ORDER BY occurred_at, event_key
    `).all() as Array<{ event_key: string; event_type: string; reason: string }>;
    assert.deepEqual(rows, [
      { event_key: `legacy_server_event:${firstJoin}`, event_type: 'bot_joined', reason: '' },
      { event_key: `legacy_server_event:${secondJoin}`, event_type: 'bot_joined', reason: '' },
      { event_key: `legacy_server_event:${kicked}`, event_type: 'bot_removed', reason: '' },
      { event_key: 'already-recorded', event_type: 'bot_joined', reason: '' },
    ]);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM analytics_server_events WHERE event_key = ?')
        .get(`legacy_server_event:${dualWritten}`).count,
      0,
    );
    db.close();

    service = new DatabaseService();
    service.onModuleDestroy();
    service = undefined;
    db = new Database(dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analytics_server_events').get().count, 4);
    db.close();
  } finally {
    service?.onModuleDestroy();
    process.chdir(previousCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
