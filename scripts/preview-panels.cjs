// Local preview: isolated database, no bot connections and no external email.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const previewDir = path.join(os.tmpdir(), 'xgoatcast-panels-preview');
fs.mkdirSync(previewDir, { recursive: true });
const envFile = path.join(previewDir, 'preview.env');
fs.writeFileSync(envFile, '# Isolated local preview; never load the project .env.\n');
Object.assign(process.env, {
  XGOAT_ENV_FILE: envFile, HOST: '127.0.0.1', PORT: '3521',
  SUPER_ADMIN_PASSWORD: 'PreviewSuper2026',
  KOOK_BOT_TOKEN: '', KOOK_VERIFY_TOKEN: '', KOOK_ENCRYPT_KEY: '',
  HEYCHAT_BOT_ID: '', HEYCHAT_BOT_TOKEN: '', QQ_APP_ID: '', QQ_APP_SECRET: '',
  SMTP_HOST: 'local-preview.invalid', SMTP_USER: 'preview', SMTP_PASS: 'preview', SMTP_FROM: 'preview@example.test',
  ALLOWED_ORIGINS: 'http://localhost:3521,http://127.0.0.1:3521', TRUST_PROXY: '',
});
process.chdir(previewDir);
const messages = [];
// This override exists only in this preview process; production SMTP is untouched.
require('nodemailer').createTransport = () => ({
  async sendMail(message) {
    messages.unshift({ to: message.to, subject: message.subject, text: message.text, at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) });
    messages.splice(30);
    return { accepted: [message.to] };
  },
});
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inbox = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>本地测试收件箱</title><style>body{font:16px system-ui;background:#10131e;color:#e8ebf7;max-width:760px;margin:48px auto;padding:20px}a{color:#a3d8ff}article{background:#202535;padding:20px;border-radius:14px;margin:18px 0}pre{white-space:pre-wrap;line-height:1.8}</style><h1>本地测试收件箱</h1><p>仅用于当前测试服，邮件不会真实发送。输入任意测试邮箱后，到这里刷新查看验证码。</p><p><a href="http://localhost:3521/panels/register">注册面板</a> · <a href="/">刷新邮件</a></p>${messages.length ? messages.map(m => `<article><strong>${escape(m.subject)}</strong><p>${escape(m.to)} · ${escape(m.at)}</p><pre>${escape(m.text)}</pre></article>`).join('') : '<p>暂无邮件。</p>'}</html>`);
});
inbox.listen(3522, '127.0.0.1');
inbox.on('error', error => { console.error('Preview inbox failed:', error.message); process.exit(1); });
const { DatabaseService } = require(path.join(root, 'server/dist/modules/database/database.service.js'));
const bcrypt = require('bcryptjs');
const db = new DatabaseService();
db.setGlobalConfig('publicDomain', 'http://localhost:3521');
const existing = db.getSpace('panel', 'demo123');
if (!existing) {
  const space = db.createSpace({ platform: 'panel', externalId: 'demo123', displayName: '橙子的小站', ownerId: '' });
  db.updateServer(space.serverId, {
    bound: 1,
    passwordHash: bcrypt.hashSync('PreviewPanel2026', 10),
    // Placeholder credentials let reviewers reach the share/view UI. They cannot carry real media.
    agoraAppId: '00000000000000000000000000000000',
    agoraAppCertificate: '11111111111111111111111111111111',
    idleTimeoutSec: 600,
    noViewerTimeoutSec: 600,
  });
  db.integrationDatabase.prepare('INSERT INTO panel_accounts(id,email,space_id) VALUES(?,?,?)').run('demo123', 'demo@example.test', space.serverId);
}
db.onModuleDestroy();
console.log('PREVIEW: http://localhost:3521/panels/register');
console.log('DEMO PANEL: http://localhost:3521/demo123 (UI only; configure real Agora credentials to stream)');
console.log('INBOX: http://localhost:3522 (local mock email only)');
require(path.join(root, 'server/dist/main.js'));
