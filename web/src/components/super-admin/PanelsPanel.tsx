import { useEffect, useState } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { panelRequest } from '../../lib/panels';
import { api } from '../../lib/api';

export default function PanelsPanel() {
  const [data, setData] = useState<any>(null); const [page, setPage] = useState(1);
  const [domain, setDomain] = useState(''); const [copiedId, setCopiedId] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => setData(await panelRequest(`super/panels?page=${page}`));
  useEffect(() => {
    load().catch(e => setError(e.message));
    api.getSuperConfig().then(cfg => setDomain(String(cfg.publicDomain || '').replace(/\/+$/, ''))).catch(() => {});
  }, [page]);
  const panelUrl = (id: string) => `${domain || window.location.origin}/${id}`;
  const copyUrl = async (id: string) => {
    const url = panelUrl(id);
    try { await navigator.clipboard.writeText(url); }
    catch {
      const area = document.createElement('textarea');
      area.value = url;
      area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* 复制失败时用户仍可手动选中地址 */ }
      document.body.removeChild(area);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(current => (current === id ? '' : current)), 2000);
  };
  const change = async (id: string, disabled: boolean) => {
    setBusy(true); setError('');
    try { await panelRequest(`super/panels/${id}/status`, { disabled }, 'PUT'); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="glass rounded-2xl p-6 space-y-5"><h2 className="text-xl font-semibold">自建共享面板</h2><p className="text-sm text-muted">仅管理面板基本信息和启停状态。停用会立即结束该面板的全部共享。</p>{error && <p role="alert" className="text-red-300">{error}</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="text-muted"><tr><th className="p-3">面板 ID / 名称</th><th className="p-3">绑定邮箱</th><th className="p-3">面板地址</th><th className="p-3">创建时间</th><th className="p-3">状态</th><th className="p-3">操作</th></tr></thead><tbody>{data?.panels.map((p: any) => <tr key={p.id} className="border-t border-white/10"><td className="p-3"><p>{p.id}</p><p className="text-dim">{p.name}</p></td><td className="p-3">{p.email}</td><td className="p-3"><div className="flex items-center gap-2 max-w-xs"><span className="break-all text-xs text-muted">{panelUrl(p.id)}</span><button type="button" aria-label="复制面板地址" title="复制面板地址" className="shrink-0 p-1.5 rounded-lg text-muted hover:text-white hover:bg-white/5" onClick={() => copyUrl(p.id)}>{copiedId === p.id ? <Check size={14} className="text-green-300" /> : <Copy size={14} />}</button></div></td><td className="p-3">{new Date(p.createdAt).toLocaleString()}</td><td className="p-3">{p.status === 'active' ? '已启用' : '已停用'}</td><td className="p-3"><div className="flex items-center gap-3"><a href={panelUrl(p.id)} target="_blank" rel="noopener noreferrer" className="btn-brand inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm"><ExternalLink size={15} />打开面板</a><button disabled={busy} className={p.status === 'active' ? 'text-red-300' : 'text-brand'} onClick={() => change(p.id, p.status === 'active')}>{p.status === 'active' ? '停用面板' : '恢复启用'}</button></div></td></tr>)}</tbody></table></div>
    {!data?.panels.length && <p className="text-muted text-sm">暂无面板</p>}<div className="flex justify-between text-sm"><button disabled={page === 1 || busy} onClick={() => setPage(p => p - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!data?.hasMore || busy} onClick={() => setPage(p => p + 1)}>下一页</button></div>
  </section>;
}
