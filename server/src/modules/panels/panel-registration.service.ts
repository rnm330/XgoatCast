import { BadRequestException, ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt } from 'crypto';
import type { Request } from 'express';
import { DatabaseService } from '../database/database.service';
import { PanelAccessService } from './panel-access.service';
import * as svgCaptcha from 'svg-captcha';
import * as nodemailer from 'nodemailer';
import * as tencentcloud from 'tencentcloud-sdk-nodejs-ses';
import { verificationEmailHtml } from './email-template';

const SesClient = tencentcloud.ses.v20201002.Client;
type SesClientInstance = InstanceType<typeof SesClient>;

const RESERVED = new Set(['share', 'view', 'super', 'spaces', 'panels', 'register', 'recover', 'admin', 'assets', 'updates', 'api', 'kook', 'health', 'favicon']);
export function normalizePanelId(input: unknown): string {
  if (typeof input !== 'string') throw new BadRequestException('请输入面板 ID');
  const id = input.toLowerCase();
  if (!/^[a-z0-9]{5,16}$/.test(id) || /^(.)\1+$/.test(id) || RESERVED.has(id)) throw new BadRequestException('面板 ID 须为 5～16 位字母或数字，不能全部为同一字符或使用系统保留名称');
  return id;
}

@Injectable()
export class PanelRegistrationService {
  private readonly captchas = new Map<string, { answer: string; expires: number }>();
  private readonly codeKey = randomBytes(32);
  private sending = 0;
  private transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  private ses: SesClientInstance | undefined;
  constructor(private readonly db: DatabaseService, private readonly access: PanelAccessService) {}
  availability(req: Request, value: unknown) {
    this.access.limit(`id-check:${this.access.ip(req)}`, 60);
    try {
      const id = normalizePanelId(value);
      const taken = !!this.db.getServer(id) || !!this.access.sql.prepare('SELECT 1 FROM panel_accounts WHERE id = ?').get(id);
      return { available: !taken, message: taken ? '该面板 ID 已被使用' : '该面板 ID 可以使用' };
    } catch (error) {
      if (error instanceof BadRequestException) return { available: false, message: error.message };
      throw error;
    }
  }
  private mailConfig() {
    const row = this.access.sql.prepare("SELECT value FROM global_config WHERE key='smtpSettings'").get() as any;
    if (row) return { fromName: 'Xgoat.Cast', ...JSON.parse(row.value) };
    const provider = process.env.MAIL_PROVIDER || (process.env.SMTP_HOST ? 'smtp' : 'tencent-ses');
    return { provider,
      host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT || 465), secure: process.env.SMTP_SECURE !== 'false',
      user: process.env.SMTP_USER || '', password: process.env.SMTP_PASS || '',
      from: provider === 'tencent-ses' ? process.env.SES_FROM || process.env.SMTP_FROM || '' : process.env.SMTP_FROM || '',
      fromName: process.env.MAIL_FROM_NAME || 'Xgoat.Cast',
      secretId: process.env.SES_SECRET_ID || '', secretKey: process.env.SES_SECRET_KEY || '',
      region: process.env.SES_REGION || 'ap-guangzhou', templateId: Number(process.env.SES_TEMPLATE_ID || 0) };
  }
  mailSettings() {
    const c = this.mailConfig();
    return { provider: c.provider === 'tencent-ses' ? 'tencent-ses' : 'smtp', host: c.host || '', port: Number(c.port || 465),
      secretId: c.secretId || '',
      secure: c.secure !== false, user: c.user || '', from: c.from || '', fromName: c.fromName || '', region: c.region === 'ap-hongkong' ? 'ap-hongkong' : 'ap-guangzhou',
      templateId: Number(c.templateId || 0) || '', passwordSet: !!c.password, secretKeySet: !!c.secretKey, ready: this.mailReady() };
  }
  saveMailSettings(input: any) {
    const text = (key: string) => {
      if (typeof input[key] !== 'string' || input[key].length > 320 || /[\r\n]/.test(input[key])) throw new BadRequestException('邮件配置格式无效');
      return input[key].trim();
    };
    if (input.provider !== undefined && !['smtp', 'tencent-ses'].includes(input.provider)) throw new BadRequestException('发信方式无效');
    const provider = input.provider || 'smtp';
    const from = text('from');
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) throw new BadRequestException('请填写有效的发件邮箱');
    const prev = this.mailConfig();
    const fromName = input.fromName === undefined ? String(prev.fromName || '') : text('fromName').replace(/[<>"\\]/g, '').slice(0, 64);
    let next: any;
    if (provider === 'tencent-ses') {
      const secretId = text('secretId');
      const secretKey = typeof input.secretKey === 'string' ? input.secretKey.trim() : '';
      if (!secretId || (!secretKey && !prev.secretKey)) throw new BadRequestException('请填写腾讯云 SecretId 和 SecretKey');
      if (/\s/.test(secretId) || /\s/.test(secretKey) || secretKey.length > 320) throw new BadRequestException('腾讯云密钥格式无效');
      if (secretId !== prev.secretId && !secretKey) throw new BadRequestException('更换 SecretId 时，请同时填写配套的 SecretKey');
      if (!['ap-guangzhou', 'ap-hongkong'].includes(input.region)) throw new BadRequestException('SES 地域仅支持广州或香港');
      if (!/^[1-9]\d*$/.test(String(input.templateId)) || !Number.isSafeInteger(Number(input.templateId))) throw new BadRequestException('请填写已审核通过的腾讯云邮件模板 ID');
      next = { secretId, secretKey: secretKey || prev.secretKey, region: input.region, templateId: Number(input.templateId) };
    } else {
      const host = text('host'), user = text('user');
      if (!host || /[\s/]/.test(host) || !user) throw new BadRequestException('请填写有效的 SMTP 主机和账号');
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || typeof input.secure !== 'boolean') throw new BadRequestException('端口或加密方式无效');
      const password = typeof input.password === 'string' ? input.password.trim() : '';
      if (!password && !prev.password) throw new BadRequestException('请输入 SMTP 密码或授权码');
      next = { host, user, port: input.port, secure: input.secure, password: password || prev.password };
    }
    this.db.setGlobalConfig('smtpSettings', JSON.stringify({ provider, from, fromName, ...next,
      host: next.host || prev.host || '', user: next.user || prev.user || '', port: next.port || prev.port || 465, secure: next.secure ?? prev.secure ?? true,
      password: next.password || prev.password || '', secretId: next.secretId || prev.secretId || '', secretKey: next.secretKey || prev.secretKey || '',
      region: next.region || prev.region || 'ap-guangzhou', templateId: next.templateId || prev.templateId || 0 }));
    this.transport = undefined;
    this.ses = undefined;
    return this.mailSettings();
  }
  private mailTransport() {
    const c = this.mailConfig();
    return this.transport ||= nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure,
      auth: { user: c.user, pass: c.password }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  }
  private sesClient() {
    const c = this.mailConfig();
    return this.ses ||= new SesClient({ credential: { secretId: c.secretId, secretKey: c.secretKey }, region: c.region || 'ap-guangzhou',
      profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com', reqTimeout: 15 } } });
  }
  mailReady() {
    const c = this.mailConfig();
    if (c.provider === 'tencent-ses') return !!(c.secretId && c.secretKey && Number.isSafeInteger(Number(c.templateId)) && Number(c.templateId) > 0 && c.from && ['ap-guangzhou', 'ap-hongkong'].includes(c.region));
    return (!c.provider || c.provider === 'smtp') && !!(c.host && c.from && c.user && c.password);
  }
  private emailText(scene: string, code: string) {
    return `你正在${scene}，验证码 ${code}，10 分钟内有效。请勿转发给任何人；如果不是你本人操作，请忽略此邮件，你的账号不会受到任何影响。`;
  }
  private async sendMail(mail: { to: string; subject: string; scene: string; code: string }) {
    if (!this.mailReady()) throw new ServiceUnavailableException('邮件服务尚未配置');
    if (this.sending >= 2) throw new ServiceUnavailableException('邮件发送繁忙，请稍后重试');
    this.access.limit('mail:dispatch', 20, 1000);
    const c = this.mailConfig();
    this.sending++;
    try {
      if (c.provider === 'tencent-ses') {
        const result = await this.sesClient().SendEmail({ FromEmailAddress: c.from, Destination: [mail.to], Subject: mail.subject, TriggerType: 1,
          Template: { TemplateID: Number(c.templateId), TemplateData: JSON.stringify({ code: mail.code }) } });
        return { messageId: result.MessageId, requestId: result.RequestId };
      }
      await this.mailTransport().sendMail({ from: c.fromName ? { name: c.fromName, address: c.from } : c.from, to: mail.to, subject: mail.subject, html: verificationEmailHtml(mail.code), text: this.emailText(mail.scene, mail.code) });
      return {};
    } finally { this.sending--; }
  }
  async testMail(req: Request, input: any) {
    this.access.limit(`smtp-test:${this.access.ip(req)}`, 3, 60_000);
    const provider = this.mailConfig().provider;
    if (!this.mailReady()) throw new BadRequestException('请先保存邮件配置');
    const to = input.to ? this.email(input.to) : undefined;
    try {
      if (!to) {
        if (provider === 'tencent-ses') throw new BadRequestException('请填写测试收件邮箱，通过发送测试邮件验证 SES 配置');
        await this.mailTransport().verify();
        return { ok: true };
      }
      const scene = '测试邮件服务';
      const receipt = await this.sendMail({ to, subject: 'Xgoat.Cast 邮件服务测试', scene, code: String(randomInt(100000, 1000000)) });
      return { ok: true, ...receipt };
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      const errorCode = String(e?.code || e?.responseCode || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
      const requestId = String(e?.requestId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80);
      const hints: Record<string, string> = {
        'FailedOperation.TemplateNotExist': '模板不存在，请检查模板 ID 和地域',
        'FailedOperation.TemplateStatusException': '模板尚未审核通过，请检查腾讯云模板审核状态',
        'FailedOperation.WithOutPermission': '请检查 SES 开通状态、发信权限及模板配置',
        'AuthFailure.SignatureFailure': '密钥签名失败，请检查 SecretId 与 SecretKey 是否配套',
        'AuthFailure.SecretIdNotFound': 'SecretId 不存在或已被禁用',
        'UnauthorizedOperation': '当前密钥没有邮件发送权限，请检查 CAM 授权',
      };
      const detail = errorCode ? `（错误码 ${errorCode}）` : '';
      const hint = hints[errorCode] || `请检查配置${provider === 'tencent-ses' ? '、SecretId/SecretKey、地域与模板审核状态' : '及邮件服务商限制'}`;
      throw new ServiceUnavailableException(`邮件发送失败${detail}，${hint}${requestId ? `；请求 ID：${requestId}` : ''}`);
    }
  }
  private email(value: unknown) {
    const email = this.access.text(value, '邮箱', 3, 254).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('邮箱格式不正确');
    return email;
  }
  captcha(req: Request) {
    this.access.limit(`captcha:${this.access.ip(req)}`, 12);
    this.access.limit('captcha:global', 120);
    const now = Date.now();
    for (const [id, c] of this.captchas) if (c.expires <= now) this.captchas.delete(id);
    if (this.captchas.size >= 600) throw new ServiceUnavailableException('验证码服务繁忙');
    const result = svgCaptcha.create({ size: 5, noise: 2, color: true, background: '#f1f5f9', ignoreChars: '0oO1ilI' });
    const id = randomBytes(24).toString('hex');
    this.captchas.set(id, { answer: result.text.toLowerCase(), expires: now + 5 * 60_000 });
    return { id, image: `data:image/svg+xml;base64,${Buffer.from(result.data).toString('base64')}` };
  }
  private verifyCaptcha(id: unknown, answer: unknown) {
    if (typeof id !== 'string' || typeof answer !== 'string') throw new BadRequestException('请输入图片验证码');
    const c = this.captchas.get(id);
    this.captchas.delete(id); // one attempt, including failures
    if (!c || c.expires <= Date.now() || c.answer !== answer.trim().toLowerCase()) throw new BadRequestException('图片验证码错误或已过期，请刷新');
  }
  private codeHash(email: string, purpose: string, code: string) {
    return createHmac('sha256', this.codeKey).update(`${email}\n${purpose}\n${code}`).digest('hex');
  }
  async sendCode(req: Request, input: any) {
    if (!this.mailReady()) throw new ServiceUnavailableException('邮件服务尚未配置，暂不能注册或找回密码');
    const email = this.email(input.email);
    const purpose = input.purpose;
    if (purpose !== 'register' && purpose !== 'recover') throw new BadRequestException('验证用途无效');
    this.access.limit(`mail:ip:${this.access.ip(req)}`, 5, 15 * 60_000);
    this.verifyCaptcha(input.captchaId, input.captcha);
    this.access.limit(`mail:email:${email}`, 1, 60_000);
    this.access.limit(`mail:day:${email}`, 10, 24 * 3600_000);
    this.access.limit('mail:global', 30);
    const sql = this.access.sql;
    const exists = sql.prepare('SELECT id FROM panel_accounts WHERE email = ?').get(email);
    // Do not reveal account existence through recovery or mail-send responses.
    if ((purpose === 'register' && exists) || (purpose === 'recover' && !exists)) return { ok: true };
    const code = String(randomInt(100000, 1000000));
    const hash = this.codeHash(email, purpose, code);
    try {
      sql.prepare('DELETE FROM panel_email_codes WHERE expires_at <= ?').run(Date.now());
      if ((sql.prepare('SELECT COUNT(*) AS n FROM panel_email_codes').get() as any).n >= 1000) throw new ServiceUnavailableException('验证服务繁忙');
      sql.prepare(`INSERT INTO panel_email_codes(email, purpose, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(email, purpose) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`).run(email, purpose, hash, Date.now() + 10 * 60_000);
      const scene = purpose === 'register' ? '注册账号' : '找回密码';
      await this.sendMail({ to: email, subject: `Xgoat.Cast ${scene}验证码`, scene, code });
      return { ok: true };
    } catch {
      sql.prepare('DELETE FROM panel_email_codes WHERE email = ? AND purpose = ? AND code_hash = ?').run(email, purpose, hash);
      throw new ServiceUnavailableException('邮件发送失败，请稍后重试');
    }
  }
  private checkCode(email: string, purpose: string, value: unknown) {
    const code = this.access.text(value, '邮箱验证码', 6, 6);
    const record = this.access.sql.prepare('SELECT * FROM panel_email_codes WHERE email = ? AND purpose = ?').get(email, purpose) as any;
    if (!record || record.expires_at <= Date.now() || record.attempts >= 5) throw new BadRequestException('邮箱验证码错误或已过期');
    if (record.code_hash !== this.codeHash(email, purpose, code)) {
      this.access.sql.prepare('UPDATE panel_email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?').run(email, purpose);
      throw new BadRequestException('邮箱验证码错误或已过期');
    }
    return record.code_hash as string;
  }
  private consume(email: string, purpose: string, hash: string) {
    const result = this.access.sql.prepare('DELETE FROM panel_email_codes WHERE email = ? AND purpose = ? AND code_hash = ? AND expires_at > ? AND attempts < 5').run(email, purpose, hash, Date.now());
    if (result.changes !== 1) throw new BadRequestException('邮箱验证码已使用或过期');
  }
  async register(req: Request, input: any) {
    this.access.limit(`register:${this.access.ip(req)}`, 10, 15 * 60_000);
    const id = normalizePanelId(input.id);
    const email = this.email(input.email);
    const password = this.access.password(input.password);
    this.access.confirmPassword(password, input.confirmPassword);
    const codeHash = this.checkCode(email, 'register', input.code);
    const sql = this.access.sql;
    const available = () => {
      if (this.db.getServer(id) || sql.prepare('SELECT id FROM panel_accounts WHERE id = ? OR email = ?').get(id, email)) throw new ConflictException('面板 ID 或邮箱已被使用');
    };
    available();
    const hash = await this.access.hash(password);
    sql.transaction(() => {
      available();
      this.consume(email, 'register', codeHash);
      const space = this.db.createSpace({ platform: 'panel', externalId: id, displayName: id, ownerId: '' });
      this.db.updateServer(space.serverId, { passwordHash: hash, bound: 1 });
      sql.prepare('INSERT INTO panel_accounts(id, email, space_id) VALUES (?, ?, ?)').run(id, email, space.serverId);
    })();
    return { ok: true, id };
  }
  async recover(req: Request, input: any) {
    this.access.limit(`recover:${this.access.ip(req)}`, 10, 15 * 60_000);
    const email = this.email(input.email);
    const password = this.access.password(input.password);
    this.access.confirmPassword(password, input.confirmPassword);
    const codeHash = this.checkCode(email, 'recover', input.code);
    const account = this.access.sql.prepare('SELECT * FROM panel_accounts WHERE email = ?').get(email) as any;
    if (!account) throw new BadRequestException('找回信息无效');
    const hash = await this.access.hash(password);
    this.access.sql.transaction(() => {
      this.consume(email, 'recover', codeHash);
      this.db.updateServer(account.space_id, { passwordHash: hash });
      this.access.rotateSecret(account.space_id);
    })();
    return { ok: true, id: account.id };
  }
}
