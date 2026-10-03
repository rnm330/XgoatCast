import { Injectable } from '@nestjs/common';

export class QqApiError extends Error {
  constructor(readonly status: number, readonly code: number, readonly uncertain = false) {
    super(`QQ API ${status}/${code}${uncertain ? ' (delivery unknown)' : ''}`);
  }
}

@Injectable()
export class QqApiService {
  private token = '';
  private expiresAt = 0;
  private refreshing?: Promise<string>;
  get appId() { return process.env.QQ_APP_ID?.trim() || ''; }
  get secret() { return process.env.QQ_APP_SECRET?.trim() || ''; }
  get configured() { return !!this.appId && !!this.secret; }

  private async transport(path: string, method: string, body?: unknown, token?: string): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`https://api.bot.qq.com${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000),
      });
    } catch { throw new QqApiError(0, 0, method !== 'GET'); }
    let data: any;
    try { data = response.status === 204 ? {} : await response.json(); }
    catch { throw new QqApiError(response.status, 0, method !== 'GET'); }
    const code = Number(data.err_code ?? data.code ?? 0);
    if (!response.ok || code) throw new QqApiError(response.status, code, response.status >= 500 && method !== 'GET');
    return data;
  }

  private async accessToken(): Promise<string> {
    if (!this.configured) throw new QqApiError(503, 0);
    if (this.token && Date.now() < this.expiresAt - 45_000) return this.token;
    if (!this.refreshing) this.refreshing = (async () => {
      const result = await this.transport('/app/getAppAccessToken', 'POST', { appId: this.appId, clientSecret: this.secret });
      if (!result.access_token || !Number(result.expires_in)) throw new QqApiError(502, 0);
      this.token = result.access_token;
      this.expiresAt = Date.now() + Number(result.expires_in) * 1000;
      return this.token;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    try { return await this.transport(path, method, body, await this.accessToken()); }
    catch (error) {
      if (!(error instanceof QqApiError) || error.status !== 401) throw error;
      this.token = '';
      return this.transport(path, method, body, await this.accessToken());
    }
  }

  async memberRole(group: string, user: string): Promise<string> {
    const data = await this.request(`/v2/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(user)}`);
    return typeof data.member_role === 'string' ? data.member_role : '';
  }

  async syncPanel() {
    const remark = 'XgoatCast QQ group commands';
    const panel = { remark, items: [
      { type: 'command', name: '管理', desc: '绑定或打开本群管理', only_admin: true },
      { type: 'command', name: '屏幕共享', desc: '发起网页屏幕共享', only_admin: false },
      { type: 'command', name: '帮助', desc: '查看使用说明', only_admin: false },
    ] };
    let cursor = '';
    do {
      const data = await this.request(`/v2/panels?scope=group&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const existing = (data.records || []).find((row: any) => row.panel?.remark === remark && row.target_type === 'all');
      if (existing) {
        await this.request(`/v2/panels/${encodeURIComponent(existing.panel_id)}`, 'PUT', { panel });
        return { panelId: existing.panel_id, updated: true };
      }
      cursor = !data.is_end && data.next_cursor !== cursor ? data.next_cursor || '' : '';
    } while (cursor);
    const result = await this.request('/v2/panels', 'POST', { scope: 'group', target_type: 'all', panel });
    return { panelId: result.panel_id, updated: false };
  }
}
