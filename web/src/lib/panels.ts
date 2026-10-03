import { getSuperAdminToken } from './api';

export class PanelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function panelRequest<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method, credentials: 'include', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(path.startsWith('super/') ? { Authorization: `Bearer ${getSuperAdminToken() || ''}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PanelError(response.status, Array.isArray(data.message) ? data.message.join('；') : data.message || '请求失败，请稍后重试');
  return data as T;
}
