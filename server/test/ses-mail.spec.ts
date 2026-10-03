import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/modules/database/database.service';
import { PanelAccessService } from '../src/modules/panels/panel-access.service';
import { PanelRegistrationService } from '../src/modules/panels/panel-registration.service';
import { VERIFICATION_EMAIL_TEMPLATE, verificationEmailHtml } from '../src/modules/panels/email-template';

const config = { provider: 'tencent-ses', from: 'noreply@example.test', secretId: 'test-secret-id', secretKey: 'test-secret-key', region: 'ap-guangzhou', templateId: 12345 };
const request = { ip: '127.0.0.1' } as any;
async function withService(run: (service: PanelRegistrationService, db: DatabaseService) => Promise<void>) {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'ses-mail-'));
  process.chdir(root);
  const db = new DatabaseService();
  try { await run(new PanelRegistrationService(db, new PanelAccessService(db)), db); }
  finally { db.onModuleDestroy(); process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
}

test('SES config survives restart, preserves an unchanged key and rejects mismatched credentials or invalid region/template', async () => {
  await withService(async (initial, db) => {
    const saved = initial.saveMailSettings(config);
    assert.equal(saved.secretId, config.secretId);
    assert.equal(saved.secretKeySet, true);
    assert.equal(saved.ready, true);
    assert.equal(JSON.stringify(saved).includes(config.secretKey), false);
    const service = new PanelRegistrationService(db, new PanelAccessService(db));
    service.saveMailSettings({ ...service.mailSettings(), secretKey: '' });
    assert.equal((service as any).mailConfig().secretKey, config.secretKey);
    for (const invalid of [
      { secretId: 'different-id', secretKey: '' }, { region: 'ap-singapore' },
      { templateId: '1e3' }, { templateId: true }, { templateId: 1.5 },
      { templateId: Number.MAX_SAFE_INTEGER + 1 }, { provider: 'typo' },
    ]) assert.throws(() => service.saveMailSettings({ ...config, ...invalid }));
    assert.equal(service.mailSettings().secretId, config.secretId);
  });
});

test('SES test uses only SendEmail template API with trigger flag and exposes provider receipt without secrets', async () => {
  await withService(async service => {
    service.saveMailSettings(config);
    let calls = 0;
    (service as any).transport = { sendMail: () => { throw Error('SMTP must never be used'); }, verify: () => { throw Error('SMTP must never be used'); } };
    (service as any).ses = { SendEmail: async (payload: any) => {
      calls++;
      assert.equal(payload.TriggerType, 1);
      assert.equal(payload.FromEmailAddress, config.from);
      assert.deepEqual(payload.Destination, ['reader@example.test']);
      assert.equal(payload.Template.TemplateID, config.templateId);
      assert.equal('Simple' in payload, false);
      const variables = JSON.parse(payload.Template.TemplateData);
      assert.deepEqual(Object.keys(variables), ['code']);
      assert.match(variables.code, /^\d{6}$/);
      return { MessageId: 'message-id', RequestId: 'request-id' };
    } };
    await assert.rejects(() => service.testMail(request, {}), /测试收件邮箱/);
    assert.equal(calls, 0);
    assert.deepEqual(await service.testMail(request, { to: 'Reader@Example.test' }), { ok: true, messageId: 'message-id', requestId: 'request-id' });
    assert.equal(calls, 1);
  });
});

test('failed SES sends include safe diagnostics for admin and invalidate the unusable registration code', async () => {
  await withService(async (service, db) => {
    service.saveMailSettings(config);
    (service as any).ses = { SendEmail: async () => { throw Object.assign(new Error('sensitive SDK details'), { code: 'AuthFailure.SignatureFailure', requestId: 'request-123' }); } };
    await assert.rejects(() => service.testMail(request, { to: 'reader@example.test' }), error => {
      assert.match((error as Error).message, /AuthFailure.SignatureFailure/);
      assert.match((error as Error).message, /request-123/);
      assert.doesNotMatch((error as Error).message, /sensitive SDK details/);
      return true;
    });
    (service as any).captchas.set('captcha-test', { answer: 'abcde', expires: Date.now() + 60_000 });
    await assert.rejects(() => service.sendCode(request, { email: 'reader@example.test', purpose: 'register', captchaId: 'captcha-test', captcha: 'abcde' }), /邮件发送失败/);
    assert.equal((db.integrationDatabase.prepare('SELECT COUNT(*) AS n FROM panel_email_codes').get() as any).n, 0);
    assert.equal((service as any).sending, 0);
  });
});

test('SES dispatch bounds concurrent requests and per-second rate, including test messages', async () => {
  await withService(async service => {
    service.saveMailSettings(config);
    const message = { to: 'reader@example.test', subject: 'test', scene: '注册账号', code: '123456' };
    const releases: (() => void)[] = [];
    (service as any).ses = { SendEmail: () => new Promise(resolve => releases.push(() => resolve({}))) };
    const first = (service as any).sendMail(message), second = (service as any).sendMail(message);
    await assert.rejects(() => service.testMail(request, { to: message.to }));
    assert.equal(releases.length, 2);
    releases.forEach(release => release());
    await Promise.all([first, second]);
    assert.equal((service as any).sending, 0);
  });
  await withService(async service => {
    service.saveMailSettings(config);
    const now = Date.now, fixed = now();
    Date.now = () => fixed;
    try {
      let calls = 0;
      (service as any).ses = { SendEmail: async () => { calls++; return {}; } };
      const message = { to: 'reader@example.test', subject: 'test', scene: '注册账号', code: '123456' };
      for (let i = 0; i < 20; i++) await (service as any).sendMail(message);
      await assert.rejects(() => (service as any).sendMail(message), /过于频繁/);
      assert.equal(calls, 20);
    } finally { Date.now = now; }
  });
});

test('SES environment config uses SES_FROM, rejects unsupported regions and never returns SecretKey', async () => {
  const names = ['MAIL_PROVIDER', 'SES_FROM', 'SES_SECRET_ID', 'SES_SECRET_KEY', 'SES_REGION', 'SES_TEMPLATE_ID'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { MAIL_PROVIDER: 'tencent-ses', SES_FROM: config.from, SES_SECRET_ID: config.secretId, SES_SECRET_KEY: config.secretKey, SES_REGION: config.region, SES_TEMPLATE_ID: String(config.templateId) });
  try {
    await withService(async service => {
      assert.equal(service.mailSettings().from, config.from);
      assert.equal(service.mailReady(), true);
      assert.equal(JSON.stringify(service.mailSettings()).includes(config.secretKey), false);
      process.env.SES_REGION = 'invalid';
      assert.equal(service.mailReady(), false);
    });
  } finally { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } }
});

test('SES template keeps a single upload variable, is self-contained and escapes rendered values', () => {
  assert.deepEqual([...VERIFICATION_EMAIL_TEMPLATE.matchAll(/{{(\w+)}}/g)].map(match => match[1]), ['code']);
  assert.doesNotMatch(VERIFICATION_EMAIL_TEMPLATE, /<script|<link|<img|https?:\/\//);
  assert.match(verificationEmailHtml('123456'), /123456/);
  const html = verificationEmailHtml('<img src=x>');
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /{{|<img/);
});

test('SMTP sender display name defaults to the brand name, is sanitized and used as the mail From', async () => {
  await withService(async service => {
    const smtp = { provider: 'smtp', from: 'noreply@msg.xgoat.top', host: 'smtp.example.test', user: 'u', port: 465, secure: true, password: 'p' };
    assert.equal(service.mailSettings().fromName, 'Xgoat.Cast');
    service.saveMailSettings({ ...smtp, fromName: 'Xgoat <Cast>" test' });
    assert.equal(service.mailSettings().fromName, 'Xgoat Cast test');
    (service as any).transport = { sendMail: async (options: any) => {
      assert.deepEqual(options.from, { name: 'Xgoat Cast test', address: smtp.from });
      return {};
    } };
    await (service as any).sendMail({ to: 'reader@example.test', subject: 't', scene: '注册账号', code: '123456' });
    service.saveMailSettings({ ...smtp, fromName: '' });
    assert.equal(service.mailSettings().fromName, '');
    (service as any).transport = { sendMail: async (options: any) => {
      assert.equal(options.from, smtp.from);
      return {};
    } };
    await (service as any).sendMail({ to: 'reader@example.test', subject: 't', scene: '注册账号', code: '123456' });
  });
});
