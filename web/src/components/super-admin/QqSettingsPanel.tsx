import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export function QqSettingsPanel() {
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setStatus(await api.getQqStatus()); };
  useEffect(() => { void refresh().catch(() => setError('QQ状态读取失败')); }, []);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (e: any) { setError(e.message || '操作失败'); }
    finally { setBusy(false); }
  };
  const all = (status?.groups || []).some((g: any) => g.last_all_message_at);
  const at = (status?.groups || []).some((g: any) => g.last_at_message_at);
  return <div className="glass rounded-2xl p-6 space-y-4">
    <h3 className="font-semibold text-white">QQ机器人</h3>
    <p className="text-sm text-muted">{status?.configured ? `已配置 · AppID ${status.appId}` : '请在服务端配置 QQ_APP_ID 和 QQ_APP_SECRET 后重启'}</p>
    <p className="text-sm text-muted">连接方式：Webhook · {status?.lastWebhookAt ? '已收到验签通过的事件' : '等待QQ回调'}</p>
    <div className="rounded-xl bg-white/5 p-3 text-sm break-all select-all">{status?.callbackUrl || '读取回调地址中…'}</div>
    <p className="text-xs text-dim">在QQ开放平台填写上方HTTPS回调地址，订阅群消息及机器人加入、退出群事件。凭据仅保存在服务端。</p>
    <p className="text-sm text-muted">普通群消息：{all ? '已收到' : '尚未收到，需群内实测'} · @机器人消息：{at ? '已收到' : '尚未收到'}</p>
    <p className="text-sm text-muted">指令面板：{status?.panel?.panelId ? '已配置' : '尚未同步'} · 管理 / 屏幕共享 / 帮助</p>
    <p className="text-xs text-dim">群主和管理员可绑定。请在群内先 @机器人，再发送管理、绑定码或屏幕共享指令。</p>
    {status?.lastDeliveryError && <p className="text-sm text-yellow-300">最近一次发送异常：{status.lastDeliveryError.error}。请检查QQ消息权限及链接配置。</p>}
    {error && <p className="text-sm text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} className="btn-brand rounded-lg px-4 py-2 text-sm" onClick={() => void act(() => api.verifyQq())}>验证连接</button>
      <button type="button" disabled={busy} className="btn-brand rounded-lg px-4 py-2 text-sm" onClick={() => void act(() => api.syncQqPanel())}>同步群指令面板</button>
      <button type="button" disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-white/5" onClick={() => void act(refresh)}>刷新状态</button>
    </div>
  </div>;
}
