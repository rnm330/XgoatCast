import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { validateSync } from 'class-validator';
import { DatabaseService } from '../src/modules/database/database.service';
import { ServerAdminController } from '../src/modules/server-admin/server-admin.controller';
import { UpdateServerConfigDto } from '../src/modules/server-admin/server-admin.dto';

test('quality preference migration defaults on, is isolated per space and preserves opt-out after restart', () => {
  const previousCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'xgoat-quality-preference-'));
  let service: DatabaseService | undefined;
  try {
    process.chdir(root);
    service = new DatabaseService();
    service.createServer('legacy', 'Legacy', 'owner', 'Owner');
    service.onModuleDestroy();
    service = undefined;
    const db = new Database(join(root, 'data/xgoatcast.db'));
    db.exec('ALTER TABLE servers DROP COLUMN allow_quality_preference');
    db.close();
    service = new DatabaseService();
    assert.equal(service.getServer('legacy')?.allowQualityPreference, 1);
    const heychat = service.createSpace({ platform: 'heychat', externalId: 'room', displayName: 'Room', ownerId: 'owner' });
    assert.equal(heychat.allowQualityPreference, 1);
    const controller = new ServerAdminController(service, {} as any);
    controller.updateConfig({ serverId: 'legacy' }, { allowQualityPreference: 0 });
    assert.equal((controller.getConfig({ serverId: 'legacy' }) as any).allowQualityPreference, 0);
    assert.equal((controller.getConfig({ platform: 'heychat', externalId: 'room' }) as any).allowQualityPreference, 1);
    service.onModuleDestroy();
    service = new DatabaseService();
    assert.equal(service.getServer('legacy')?.allowQualityPreference, 0);
    assert.equal(service.getSpace('heychat', 'room')?.allowQualityPreference, 1);
  } finally {
    service?.onModuleDestroy();
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('quality preference permission only accepts 0 or 1', () => {
  for (const value of [0, 1]) {
    assert.equal(validateSync(Object.assign(new UpdateServerConfigDto(), { allowQualityPreference: value })).length, 0);
  }
  for (const value of [-1, 2, 0.5, '1', true]) {
    assert.ok(validateSync(Object.assign(new UpdateServerConfigDto(), { allowQualityPreference: value })).length > 0);
  }
});
