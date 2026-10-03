import { createPrivateKey, createPublicKey, sign, verify } from 'crypto';

export interface QqEvent {
  op: number;
  id?: string;
  t?: string;
  d: Record<string, any>;
}

export function qqSigningKey(secret: string) {
  if (!secret) throw new Error('qq_not_configured');
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32)]),
    format: 'der', type: 'pkcs8',
  });
}

export function verifyQqSignature(secret: string, body: Buffer, timestamp: string, signature: string, now = Date.now()) {
  if (!/^\d{10,11}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000
    || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), body]),
    createPublicKey(qqSigningKey(secret)), Buffer.from(signature, 'hex'));
}

export function qqChallenge(secret: string, data: Record<string, any>) {
  if (typeof data.plain_token !== 'string' || !data.plain_token || data.plain_token.length > 1024
    || typeof data.event_ts !== 'string' || !/^\d{10,11}$/.test(data.event_ts)) throw new Error('invalid_challenge');
  return { plain_token: data.plain_token,
    signature: sign(null, Buffer.from(data.event_ts + data.plain_token), qqSigningKey(secret)).toString('hex') };
}

export const QQ_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/i;
export function qqCommand(content: unknown): { name: 'manage' | 'share' | 'help' | 'bind'; code?: string } | undefined {
  if (typeof content !== 'string') return;
  // Older payloads can include the bot mention; only strip a leading mention.
  const text = content.replace(/^\s*<@!?\d+>\s*/, '').trim().replace(/^\//, '');
  if (text === '管理' || text === 'xchelp') return { name: 'manage' };
  if (text === '屏幕共享' || text === 'xc') return { name: 'share' };
  if (text === '帮助' || text === 'help') return { name: 'help' };
  const code = text.replace(/^(管理|绑定|xchelp)\s+/, '');
  if (QQ_CODE.test(code)) return { name: 'bind', code: code.toUpperCase() };
}

export const qqAdmin = (role: unknown) => role === 'owner' || role === 'admin';
