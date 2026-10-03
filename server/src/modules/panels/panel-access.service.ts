import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { DatabaseService, ServerRecord } from '../database/database.service';

export interface PanelAccount { id: string; email: string; space_id: string; access_hash: string; access_version: number; }
export interface PanelRoom { session_id: string; panel_id: string; view_token: string; password_hash: string; title: string; }
export const PANEL_TTL = 24 * 3600;

/** Bounded process-local limits: no polling jobs or database write for each request. */
@Injectable()
export class PanelAccessService {
  private readonly limits = new Map<string, { count: number; until: number }>();
  private lastSweep = 0;
  private cryptoJobs = 0;
  constructor(private readonly db: DatabaseService) {}
  get sql() { return this.db.integrationDatabase; }
  limit(key: string, max: number, windowMs = 60_000) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      for (const [k, v] of this.limits) if (v.until <= now) this.limits.delete(k);
      this.lastSweep = now;
    }
    const current = this.limits.get(key);
    if (current && current.until > now) {
      if (current.count >= max) throw new HttpException('操作过于频繁，请稍后重试', 429);
      current.count++;
    } else {
      if (!current && this.limits.size >= 10_000) throw new HttpException('请求繁忙，请稍后重试', 429);
      this.limits.set(key, { count: 1, until: now + windowMs });
    }
  }
  ip(req: Request) { return req.ip || req.socket?.remoteAddress || 'unknown'; }
  text(value: unknown, label: string, min = 0, max = 100): string {
    if (typeof value !== 'string' || value.length < min || value.length > max) throw new BadRequestException(`${label}长度须为 ${min}～${max} 位`);
    return value;
  }
  password(value: unknown) {
    const s = this.text(value, '密码', 8, 72);
    if (Buffer.byteLength(s) > 72) throw new BadRequestException('密码不能超过 72 字节');
    if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[0-9]/.test(s)) throw new BadRequestException('管理密码至少 8 位，须包含大写字母、小写字母和数字');
    return s;
  }
  confirmPassword(password: string, confirmation: unknown) {
    if (password !== confirmation) throw new BadRequestException('两次管理密码不一致');
  }
  async hashAccessCode(value: unknown) {
    if (typeof value !== 'string' || !value.length) throw new BadRequestException('请输入授权码');
    // Prehash avoids bcrypt truncation without restricting code length or character set.
    return 'sha256$' + await this.hash(createHash('sha256').update(value).digest('base64'));
  }
  async compareAccessCode(value: unknown, hash: string) {
    if (typeof value !== 'string') return false;
    return hash.startsWith('sha256$')
      ? this.compare(createHash('sha256').update(value).digest('base64'), hash.slice(7))
      : this.compare(value, hash);
  }
  async hash(value: string) { return this.crypto(() => bcrypt.hash(value, 10)); }
  async compare(value: unknown, hash: string) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 72 || !hash) return false;
    return this.crypto(() => bcrypt.compare(value, hash));
  }
  private async crypto<T>(fn: () => Promise<T>): Promise<T> {
    if (this.cryptoJobs >= 4) throw new HttpException('验证繁忙，请稍后重试', 429);
    this.cryptoJobs++;
    try { return await fn(); } finally { this.cryptoJobs--; }
  }
  panel(id: string): { account: PanelAccount; space: ServerRecord } {
    const account = this.sql.prepare('SELECT * FROM panel_accounts WHERE id = ?').get(id.toLowerCase()) as PanelAccount;
    const space = account && this.db.getServer(account.space_id);
    if (!account || !space) throw new NotFoundException('面板不存在');
    return { account, space };
  }
  active(space: ServerRecord) {
    if (space.status !== 'active') throw new ForbiddenException('面板已停用');
  }
  roomByToken(token: string): PanelRoom | undefined {
    return this.sql.prepare('SELECT * FROM panel_rooms WHERE view_token = ?').get(token) as PanelRoom;
  }
  roomBySession(id: string): PanelRoom | undefined {
    return this.sql.prepare('SELECT * FROM panel_rooms WHERE session_id = ?').get(id) as PanelRoom;
  }
  sign(space: ServerRecord, purpose: string, version: number | string = 0) {
    const body = Buffer.from(JSON.stringify({ purpose, version, exp: Date.now() + PANEL_TTL * 1000 })).toString('base64url');
    return body + '.' + createHmac('sha256', space.serverSecret).update(body).digest('base64url');
  }
  valid(value: string, space: ServerRecord, purpose: string, version: number | string = 0) {
    try {
      const [body, signature, extra] = value.split('.');
      if (!body || !signature || extra) return false;
      const expected = createHmac('sha256', space.serverSecret).update(body).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      return Number.isFinite(data.exp) && data.exp > Date.now() && data.purpose === purpose && data.version === version;
    } catch { return false; }
  }
  cookie(req: Request, name: string) {
    const pair = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
    try { return pair ? decodeURIComponent(pair.slice(name.length + 1)) : ''; } catch { return ''; }
  }
  setCookie(res: Response, req: Request, name: string, value: string, path: string, maxAge = PANEL_TTL * 1000) {
    res.cookie(name, value, { httpOnly: true, sameSite: 'strict', secure: req.secure || this.db.getGlobalConfig().publicDomain.startsWith('https://'), path, maxAge });
  }
  admin(req: Request, id: string) {
    const panel = this.panel(id);
    if (!this.valid(this.cookie(req, `panel_admin_${panel.account.id}`), panel.space, 'admin')) throw new UnauthorizedException('请登录面板管理后台');
    return panel;
  }
  gate(req: Request, id: string) {
    const panel = this.panel(id);
    this.active(panel.space);
    if (panel.account.access_hash && !this.valid(this.cookie(req, `panel_gate_${panel.account.id}`), panel.space, 'gate', panel.account.access_version)) throw new ForbiddenException('请先输入面板授权码');
    return panel;
  }
  viewer(req: Request, room: PanelRoom) {
    const { space } = this.panel(room.panel_id);
    this.active(space);
    if (room.password_hash && !this.valid(this.cookie(req, `panel_room_${room.session_id}`), space, `room:${room.session_id}`)) throw new ForbiddenException('请先输入房间密码');
  }
  /** All share APIs and SSE use the same authorization boundary. */
  resolve(req: Request, token: string, publisher: boolean) {
    if (!token.startsWith('v_')) return { token, viewer: false };
    const room = this.roomByToken(token);
    if (!room) throw new UnauthorizedException('观看链接无效');
    if (publisher) throw new ForbiddenException('观看链接不能用于发起共享');
    this.viewer(req, room);
    const session = this.db.getSessionById(room.session_id);
    if (!session || session.status === 'ended') throw new UnauthorizedException('共享已结束');
    return { token: session.token, viewer: true };
  }
  rotateSecret(spaceId: string) { this.db.updateServer(spaceId, { serverSecret: randomBytes(32).toString('hex') }); }
}
