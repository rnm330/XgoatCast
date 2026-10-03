import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LockKeyhole, MonitorUp, Users, Settings, ArrowLeft, ArrowRight, RefreshCw, UserRound, History, LogOut, Info, Copy, Check } from 'lucide-react';
import { panelRequest, PanelError } from '../lib/panels';
import LegacyAdminMigrationPage from './LegacyAdminMigrationPage';

const inputClass = 'w-full bg-[#fffefd] border border-[#cbd0c7] rounded-lg px-3.5 py-2.5 text-sm text-[#20211f] focus:outline-none focus:border-brand';
const passwordPattern = '(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9]).{8,}';
const passwordHint = '至少 8 位，包含大写字母、小写字母和数字';
const buttonClass = 'btn-brand rounded-lg px-5 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed';
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-2"><span className="text-sm text-muted inline-flex items-center gap-1.5">{label}{hint && <span className="relative inline-flex group"><Info size={14} className="text-dim cursor-help" aria-label={hint} /><span className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-white/10 bg-[#1c2237] px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">{hint}</span></span>}</span>{children}</label>;
}
function Message({ children }: { children: ReactNode }) { return children ? <p role="status" className="text-sm text-amber-200 bg-amber-500/10 rounded-xl p-3">{children}</p> : null; }
function Shell({ title, subtitle, children, showBack = true, headerAction, footer }: { title: string; subtitle?: string; children: ReactNode; showBack?: boolean; headerAction?: ReactNode; footer?: ReactNode }) {
  return <div className="min-h-screen flex flex-col px-4 py-8 sm:py-14"><main className="w-full max-w-3xl mx-auto flex-1 space-y-7">{showBack && <Link to="/" className="text-muted text-sm inline-flex items-center gap-2"><ArrowLeft size={16} />Xgoat.Cast 屏幕共享</Link>}<header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold">{title}</h1>{subtitle && <p className="mt-3 text-muted text-sm leading-relaxed">{subtitle}</p>}</div>{headerAction}</header>{children}</main>{footer}</div>;
}

export function PanelRegistrationPage({ recover = false }: { recover?: boolean }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [captcha, setCaptcha] = useState<{ id: string; image: string } | null>(null);
  const [id, setId] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [picture, setPicture] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [sent, setSent] = useState(false); const [success, setSuccess] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [availability, setAvailability] = useState<{ id: string; available: boolean; message: string } | null>(null);
  useEffect(() => {
    if (recover || !id) { setAvailability(null); return; }
    if (!/^[a-z0-9]{5,16}$/.test(id) || /^(.)\1+$/.test(id)) {
      setAvailability({ id, available: false, message: '须为 5～16 位字母或数字，不能全部为同一字符' }); return;
    }
    let cancelled = false;
    setAvailability({ id, available: false, message: '正在检查 ID…' });
    const timer = setTimeout(() => {
      panelRequest(`panels/registration/availability?id=${encodeURIComponent(id)}`).then(result => {
        if (!cancelled) setAvailability({ id, ...result });
      }).catch(e => { if (!cancelled) setAvailability({ id, available: false, message: e.message }); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, recover]);
  const refresh = useCallback(async () => { setCaptcha(await panelRequest('panels/registration/captcha')); setPicture(''); }, []);
  useEffect(() => {
    setSuccess(''); setSent(false); setCode(''); setMessage('');
    panelRequest('panels/registration/status').then(s => setReady(s.mailReady)).catch(e => setMessage(e.message));
    void refresh().catch(e => setMessage(e.message));
  }, [recover, refresh]);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(n => n - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  const send = async () => {
    setBusy(true); setMessage('');
    try { await panelRequest('panels/registration/email', { email, purpose: recover ? 'recover' : 'register', captchaId: captcha?.id, captcha: picture }); setSent(true); setCooldown(60); setMessage(recover ? '如果邮箱已注册，验证码将发送至该邮箱。' : '如果邮箱可用于注册，验证码将发送至该邮箱。'); }
    catch (e: any) { setMessage(e.message); }
    finally { setBusy(false); await refresh().catch(e => setMessage(e.message)); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setMessage('两次管理密码不一致'); return; }
    setBusy(true); setMessage('');
    try { const result = await panelRequest(`panels/registration/${recover ? 'recover' : 'create'}`, { id, email, password, confirmPassword, code }); setSuccess(result.id); setPassword(''); setConfirmPassword(''); }
    catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
  };
  return <Shell title={recover ? '找回管理密码' : '创建你的共享面板'} subtitle={recover ? '通过绑定邮箱验证后设置新密码，原有管理登录将失效。' : '一个邮箱，一个独立面板。配置自己的声网凭证后，即可通过专属地址发起共享。'}>
    {success ? <section className="glass rounded-2xl p-6 space-y-4"><h2 className="text-xl">{recover ? '密码已重置' : '面板已创建'}</h2><p className="text-muted">你的面板地址：/{success}</p><Link className={buttonClass + ' inline-block'} to={`/${success}/admin`}>进入管理后台</Link></section> : <form onSubmit={submit} className="glass rounded-2xl p-6 space-y-5">
      {ready === null && <p className="text-muted">正在检查注册服务…</p>}
      {ready === false && <Message>邮件服务尚未配置，暂不能注册或找回密码。</Message>}
      {!recover && <Field label="面板 ID"><input className={inputClass} value={id} onChange={e => setId(e.target.value.toLowerCase())} minLength={5} maxLength={16} pattern="[A-Za-z0-9]{5,16}" placeholder="5～16 位字母或数字，如 goat2026" required /><span className="block text-xs text-dim">地址为 /{id || '你的ID'}，不区分大小写，不能全部为同一字符，创建后不可修改。</span>{availability?.id === id && <span role="status" className={`block text-xs ${availability.available ? 'text-green-300' : 'text-amber-200'}`}>{availability.message}</span>}</Field>}
      <Field label="邮箱"><input className={inputClass} type="email" autoComplete="email" value={email} onChange={e => { setEmail(e.target.value); setSent(false); }} required maxLength={254} /></Field>
      <Field label="图片验证码"><div className="flex gap-3 items-center"><input className={inputClass} value={picture} onChange={e => setPicture(e.target.value)} maxLength={5} placeholder="输入图片中的字符" />{captcha && <button type="button" disabled={busy} onClick={() => refresh().catch(e => setMessage(e.message))} title="点击刷新验证码" className="shrink-0 rounded-lg overflow-hidden"><img src={captcha.image} width={150} height={50} alt="图片验证码，点击刷新" /></button>}</div></Field>
      <div className="flex gap-3 items-end"><div className="flex-1"><Field label="邮箱验证码"><input className={inputClass} value={code} onChange={e => setCode(e.target.value)} maxLength={6} inputMode="numeric" autoComplete="one-time-code" required /></Field></div><button className={buttonClass + ' shrink-0'} type="button" onClick={send} disabled={!ready || busy || cooldown > 0 || !email || !picture || !captcha}>{cooldown ? `${cooldown} 秒后重发` : '发送验证码'}</button></div>
      <Field label={recover ? '新管理密码' : '管理密码'}><input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} maxLength={72} pattern={passwordPattern} title={passwordHint} placeholder={passwordHint} required /></Field>
      <Field label="确认管理密码"><input className={inputClass} type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} maxLength={72} required />{confirmPassword && confirmPassword !== password && <span className="text-xs text-red-300">两次管理密码不一致</span>}</Field>
      <Message>{message}</Message><button className={buttonClass + ' w-full'} disabled={!ready || busy || !sent || password !== confirmPassword || (!recover && (!availability?.available || availability.id !== id))}>{busy ? '处理中…' : recover ? '验证邮箱并重置密码' : '验证邮箱并创建面板'}</button>
      <Link className="block text-sm text-muted text-center" to={recover ? '/panels/register' : '/panels/recover'}>{recover ? '创建新面板' : '已有面板，找回密码'}</Link>
    </form>}
  </Shell>;
}

export function PanelPage() {
  const { serverId = '' } = useParams(); const id = serverId.toLowerCase();
  const [status, setStatus] = useState<any>(null); const [data, setData] = useState<any>(null); const [locked, setLocked] = useState(false);
  const [code, setCode] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false); const [title, setTitle] = useState(''); const [password, setPassword] = useState('');
  const [loadingRooms, setLoadingRooms] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadedPages = useRef(1);
  const nextCursor = useRef<string | null>(null);
  const inFlight = useRef(false);
  const load = useCallback(async (append = false) => {
    if (inFlight.current || (append && !nextCursor.current)) return;
    inFlight.current = true; setLoadingRooms(true);
    try {
      let cursor = append ? nextCursor.current : null;
      let result: any; const rooms: any[] = [];
      const count = append ? 1 : loadedPages.current;
      let fetched = 0;
      do {
        result = await panelRequest(`panels/${id}/rooms${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        rooms.push(...result.rooms); cursor = result.nextCursor; fetched++;
      } while (cursor && fetched < count && !document.hidden);
      nextCursor.current = cursor;
      loadedPages.current = append ? loadedPages.current + 1 : fetched;
      setData((previous: any) => ({ ...result, rooms: [...new Map([...(append ? previous?.rooms || [] : []), ...rooms].map(r => [r.viewLink, r])).values()] }));
      setLocked(false); setMessage('');
    } catch (e: any) {
      if (e.status === 403) { setData(null); setLocked(true); if (e.message.includes('停用')) setStatus({ exists: true, disabled: true }); }
      else setMessage(e.message);
    } finally { inFlight.current = false; setLoadingRooms(false); }
  }, [id]);
  useEffect(() => {
    let cancelled = false; setData(null); setStatus(null); setMessage(''); setCreating(false); loadedPages.current = 1; nextCursor.current = null;
    panelRequest(`panels/${id}/status`).then(async s => { if (cancelled) return; setStatus(s); if (s.exists && !s.disabled) await load(); }).catch(e => { if (!cancelled) setMessage(e.message); });
    return () => { cancelled = true; };
  }, [id, load]);
  useEffect(() => {
    if (!data || locked || status?.disabled) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 20_000);
    return () => clearInterval(timer);
  }, [!!data, locked, status?.disabled, load]);
  useEffect(() => {
    if (!sentinel.current || !data?.nextCursor || loadingRooms || message) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting && !document.hidden) void load(true); }, { rootMargin: '240px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [data?.nextCursor, loadingRooms, message, load]);
  const unlock = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setMessage(''); try { await panelRequest(`panels/${id}/unlock`, { code }); setCode(''); await load(); } catch (e: any) { setMessage(e.message); } finally { setBusy(false); } };
  const create = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setMessage(''); try { const result = await panelRequest(`panels/${id}/rooms`, { title, password }); window.location.assign(result.shareLink); } catch (e: any) { setMessage(e.message); setBusy(false); } };
  if (status?.legacy) return <LegacyAdminMigrationPage />;
  const panelName = data?.name || status?.name || '共享面板';
  return <div className="min-h-screen flex flex-col">
    <header className="border-b border-[#d9ddd6] bg-[#f8f8f6] px-5 sm:px-8"><div className="max-w-6xl mx-auto min-h-[72px] flex items-center justify-between gap-4">
      <span className="font-semibold truncate">{panelName}</span>
      <Link to={`/${id}/admin`} className="text-sm text-muted inline-flex gap-2 items-center hover:text-[#20211f]"><Settings size={16} />管理</Link>
    </div></header>
    <main className="w-full max-w-6xl mx-auto flex-1 px-5 sm:px-8 py-12 sm:py-16">
      <div className="text-center mb-10 sm:mb-12"><h1 className="text-3xl sm:text-4xl font-semibold tracking-[-0.025em] break-words">{panelName}</h1><p className="mt-4 text-muted">{status?.disabled ? '该面板已停用，暂不能创建或观看共享。' : '进入共享观看，或发起一次新的屏幕共享。'}</p></div>
      <div className="space-y-7">
        <Message>{message}</Message>
        {!status && !message && <p className="text-muted text-center">加载中…</p>}
        {status && !status.exists && <Message>地址不存在，请检查面板 ID。</Message>}
        {status?.exists && !status.disabled && locked && <form onSubmit={unlock} className="glass rounded-xl p-6 sm:p-8 space-y-5 max-w-lg mx-auto"><LockKeyhole className="text-brand-light" /><h2 className="text-lg font-semibold">输入授权码进入面板</h2><p className="text-sm text-muted">验证后可查看共享列表和发起共享，当前浏览器记住 24 小时。</p><input aria-label="面板授权码" className={inputClass} type="password" value={code} onChange={e => setCode(e.target.value)} required /><button disabled={busy} className={buttonClass}>进入面板</button></form>}
        {data && !status?.disabled && <>
          <section className="glass rounded-xl p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
            <div><h2 className="text-2xl font-semibold">发起共享</h2><p className="mt-3 text-muted">创建共享并与他人共享屏幕</p></div>
            <button className="btn-brand w-full sm:w-auto rounded-lg px-8 py-3.5 text-base font-medium inline-flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed" disabled={!data.ready} onClick={() => { setTitle(data.defaultName || '苹果'); setPassword(''); setCreating(true); setMessage(''); }}><MonitorUp size={20} />发起共享</button>
          </section>
          {!data.ready && <Message>管理员尚未配置声网凭证，暂不能创建共享。</Message>}
          {creating && <form onSubmit={create} className="glass rounded-xl p-6 space-y-4"><h2 className="text-lg font-semibold">发起共享</h2><Field label="共享人"><input className={inputClass} value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="输入你的名称" required /></Field><Field label="观看密码（可选）"><input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} maxLength={72} placeholder="留空则任何获得链接的人都可观看" autoComplete="new-password" /></Field><div className="flex gap-4"><button disabled={busy} className={buttonClass}>{busy ? '创建中…' : '创建并开始共享'}</button><button disabled={busy} type="button" className="text-sm text-muted" onClick={() => setCreating(false)}>取消</button></div></form>}
          <section className="pt-3"><div className="flex items-center justify-between gap-3 mb-5"><h2 className="font-semibold text-xl">正在进行的共享</h2><button aria-label="刷新共享列表" disabled={busy} onClick={() => load()} className="text-sm text-muted inline-flex items-center gap-2 hover:text-[#20211f]"><RefreshCw size={16} />刷新</button></div>
            <div className="space-y-3">{data.rooms.map((r: any) => <Link to={r.viewLink} key={r.viewLink} className="glass rounded-lg px-5 py-4 flex flex-wrap sm:flex-nowrap items-center gap-4 hover:border-[#b5a697] transition-colors"><div className="w-12 h-12 rounded-lg bg-[#e9ece7] flex items-center justify-center shrink-0"><MonitorUp size={23} strokeWidth={1.6} className="text-muted" /></div><div className="flex-1 min-w-0"><h3 className="font-semibold break-words">共享人：{r.title}</h3><p className="text-xs text-muted mt-1">正在共享屏幕</p></div><div className="flex items-center gap-4 text-sm text-muted"><span className="inline-flex items-center gap-1"><Users size={16} />{r.viewers} 人观看</span>{r.locked && <span className="inline-flex items-center gap-1"><LockKeyhole size={15} />密码保护</span>}<ArrowRight size={18} className="text-brand-light" /></div></Link>)}</div>
            {!data.rooms.length && <div className="glass rounded-lg p-10 text-center"><MonitorUp size={28} className="text-dim mx-auto mb-3" /><p className="text-muted">暂无正在进行的共享</p></div>}
            <div ref={sentinel} className="py-2 text-center text-sm text-muted">{loadingRooms ? '正在加载共享…' : data.nextCursor ? '向下滚动加载更多' : null}</div>
          </section>
        </>}
      </div>
    </main>
    <footer className="border-t border-[#d9ddd6] px-5 sm:px-8 py-6 text-center text-xs text-dim leading-relaxed"><p>{panelName} Powered by Xgoat.Cast™</p><p className="mt-2 opacity-70">Xgoateam™</p></footer>
  </div>;
}

export function PanelAdminPage() {
  const { serverId = '' } = useParams(); const id = serverId.toLowerCase(); const base = `panels/${id}/admin`;
  const [config, setConfig] = useState<any>(null); const [checking, setChecking] = useState(true); const [password, setPassword] = useState('');
  const [certificate, setCertificate] = useState(''); const [accessCode, setAccessCode] = useState(''); const [oldPassword, setOldPassword] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [tab, setTab] = useState<'settings' | 'history' | 'profile'>('settings');
  const [linkCopied, setLinkCopied] = useState(false);
  const [history, setHistory] = useState<any>(null); const [page, setPage] = useState(1); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const load = useCallback(async () => { setConfig(await panelRequest(`${base}/config`)); }, [base]);
  const records = useCallback(async () => { setHistory(await panelRequest(`${base}/rooms?page=${page}`)); }, [base, page]);
  useEffect(() => { setChecking(true); setConfig(null); load().catch(e => { if (e.status !== 401) setMessage(e.message); }).finally(() => setChecking(false)); }, [load]);
  useEffect(() => { if (config && tab === 'history') records().catch(e => setMessage(e.message)); }, [!!config, records, tab]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(''); try { await action(); } catch (e: any) { setMessage(e.message); if (e instanceof PanelError && e.status === 401) setConfig(null); } finally { setBusy(false); } };
  const set = (key: string, value: any) => setConfig((c: any) => ({ ...c, [key]: value }));
  const panelUrl = `${window.location.origin}/${encodeURIComponent(id)}`;
  const copyPanelUrl = async () => {
    try { await navigator.clipboard.writeText(panelUrl); setLinkCopied(true); }
    catch { setLinkCopied(false); setMessage('复制失败，请手动复制面板链接'); }
  };
  const save = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const { name, agoraAppId, allowedQualities, idleTimeoutSec, noViewerTimeoutSec, allowLowLatency, allowQualityPreference, accessEnabled } = config;
    await panelRequest(`${base}/config`, { name, agoraAppId, allowedQualities, idleTimeoutSec, noViewerTimeoutSec, allowLowLatency, allowQualityPreference, accessEnabled, ...(certificate ? { agoraAppCertificate: certificate } : {}), ...(accessCode ? { accessCode } : {}) }, 'PUT');
    setCertificate(''); setAccessCode(''); await load(); setMessage('设置已保存');
  }); };
  if (checking || !config) return <Shell title="面板管理" subtitle={`/${id} · 管理你的声网配置和共享设置`}>
    <Link to={`/${id}`} className="text-sm text-brand">返回共享面板</Link><Message>{message}</Message>
    {checking ? <p>加载中…</p> : <form onSubmit={e => { e.preventDefault(); void run(async () => { await panelRequest(`${base}/login`, { password }); setPassword(''); await load(); }); }} className="glass rounded-2xl p-6 space-y-4"><Field label="管理密码"><input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" maxLength={72} required /></Field><button className={buttonClass} disabled={busy}>登录管理后台</button><Link className="ml-5 text-sm text-muted" to="/panels/recover">忘记密码</Link></form>}
  </Shell>;
  const tabs = [
    { id: 'settings' as const, title: '面板设置', icon: Settings },
    { id: 'history' as const, title: '共享记录', icon: History },
    { id: 'profile' as const, title: '个人资料', icon: UserRound },
  ];
  return <div className="min-h-screen md:flex">
    <aside className="md:fixed md:inset-y-0 md:left-0 md:w-60 glass-strong p-5 md:p-6 flex flex-col gap-6">
      <div><Link to={`/${id}`} className="font-semibold text-lg break-words">{config.name}</Link><p className="text-xs text-muted mt-2">/{id}</p></div>
      <nav aria-label="面板管理导航" className="flex md:flex-col gap-2">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setMessage(''); }} className={`flex-1 md:flex-none flex items-center gap-2 rounded-xl px-3 py-3 text-sm ${tab === item.id ? 'bg-brand/15 text-brand-light' : 'text-muted hover:bg-white/5'}`}><item.icon size={18} />{item.title}</button>)}</nav>
      <div className="md:mt-auto flex md:flex-col gap-4"><Link to={`/${id}`} className="text-sm text-muted flex items-center gap-2"><ArrowLeft size={16} />返回共享面板</Link><button disabled={busy} className="text-sm text-muted flex items-center gap-2" onClick={() => run(async () => { await panelRequest(`${base}/logout`, {}); setConfig(null); })}><LogOut size={16} />退出登录</button></div>
    </aside>
    <main className="flex-1 md:ml-60 p-5 sm:p-8"><div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">{tabs.find(item => item.id === tab)?.title}</h1><Message>{message}</Message>
      {config.disabled && <Message>面板已停用，现有共享已结束。请联系平台管理员；恢复启用后原配置保留。</Message>}
      {tab === 'settings' && <section className="glass rounded-2xl p-6 space-y-4"><div><p className="text-sm text-muted">当前面板名</p><p className="mt-1 text-lg font-semibold break-words">{config.name}</p></div><div><p className="text-sm text-muted mb-2">共享主页链接</p><div className="flex flex-col sm:flex-row gap-2"><input aria-label="共享主页链接" className={inputClass + ' flex-1'} value={panelUrl} readOnly onFocus={e => e.target.select()} /><button type="button" onClick={copyPanelUrl} className={buttonClass + ' shrink-0 flex items-center justify-center gap-2'}>{linkCopied ? <Check size={16} /> : <Copy size={16} />}{linkCopied ? '已复制' : '复制链接'}</button></div></div></section>}
      {tab === 'settings' && (<form onSubmit={save} className="glass rounded-2xl p-6 space-y-5"><fieldset disabled={busy || config.disabled} className="space-y-5">
        <h2 className="text-lg font-semibold">面板设置</h2><Field label="面板名称"><input className={inputClass} value={config.name} onChange={e => set('name', e.target.value)} maxLength={60} required /></Field>
        <Field label="Agora App ID"><input className={inputClass} value={config.agoraAppId} onChange={e => set('agoraAppId', e.target.value.trim())} maxLength={32} autoComplete="off" /></Field>
        <Field label="Agora App Certificate"><input className={inputClass} type="password" value={certificate} onChange={e => setCertificate(e.target.value.trim())} maxLength={32} placeholder={config.certificateConfigured ? '已配置，留空保留原证书' : '填写你自己的声网证书'} autoComplete="new-password" /></Field>
        <label className="flex gap-3 text-sm"><input type="checkbox" checked={config.accessEnabled} onChange={e => set('accessEnabled', e.target.checked)} />启用面板授权码</label>
        {config.accessEnabled ? <Field label="设置或更换授权码"><input className={inputClass} type="password" value={accessCode} onChange={e => setAccessCode(e.target.value)} placeholder="区分大小写，已有授权码时留空保留" autoComplete="new-password" /><span className="block text-xs text-muted">设置后，访客需要授权码才可进入你的共享面板发起共享，观看链接不受限制。</span></Field> : <Message>未开启授权码：任何知道面板地址的人都能创建共享，使用你的声网额度。</Message>}
        <div className="space-y-2"><p className="text-sm text-muted">开放画质</p><div className="flex flex-wrap gap-4">{config.qualityOptions.map((q: any) => <label key={q.key} className="text-sm flex gap-2"><input type="checkbox" checked={config.allowedQualities.includes(q.key)} onChange={e => set('allowedQualities', e.target.checked ? [...config.allowedQualities, q.key] : config.allowedQualities.filter((k: string) => k !== q.key))} />{q.label}</label>)}</div></div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="停止共享关闭时间（秒）" hint="如果未开始共享，或共享被停止，多长时间后关闭共享链接，最长600秒。"><input className={inputClass} type="number" min={10} max={600} value={config.idleTimeoutSec} onChange={e => set('idleTimeoutSec', Number(e.target.value))} required /></Field>
          <Field label="无人观看关闭时间（秒）" hint="共享无观众观看，多长时间后关闭共享链接，最长600秒。"><input className={inputClass} type="number" min={10} max={600} value={config.noViewerTimeoutSec} onChange={e => set('noViewerTimeoutSec', Number(e.target.value))} required /></Field>
        </div>
        <label className="flex gap-3 text-sm"><input type="checkbox" checked={config.allowLowLatency} onChange={e => set('allowLowLatency', e.target.checked)} />允许低延迟模式</label><label className="flex gap-3 text-sm"><input type="checkbox" checked={config.allowQualityPreference} onChange={e => set('allowQualityPreference', e.target.checked)} />允许选择画质优先 / 帧率优先</label><button className={buttonClass}>保存设置</button>
      </fieldset></form>)}
      {tab === 'history' && (<section className="glass rounded-2xl p-6 space-y-4"><div className="flex justify-between"><h2 className="text-lg font-semibold">共享记录</h2><button disabled={busy} aria-label="刷新共享记录" onClick={() => run(records)}><RefreshCw size={18} /></button></div>{history?.rooms.map((r: any) => <div key={r.id} className="border-t border-white/10 pt-3 flex justify-between gap-3"><div><p className="break-words">{r.title}</p><p className="text-xs text-muted mt-1">{new Date(r.createdAt).toLocaleString()} · {{ active: '共享中', pending: '待开始', grace: '重连中', ended: '已结束' }[r.status as string] || r.status} · 在线 {r.viewers} · 峰值 {r.peakViewers}</p></div>{r.status !== 'ended' && <button className="text-sm text-red-300 shrink-0" disabled={busy} onClick={() => run(async () => { await panelRequest(`${base}/rooms/${r.id}/end`, {}); await records(); })}>结束共享</button>}</div>)}{!history?.rooms.length && <p className="text-muted text-sm">暂无共享记录</p>}<div className="flex justify-between text-sm"><button disabled={page === 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!history?.hasMore} onClick={() => setPage(p => p + 1)}>下一页</button></div></section>)}
      {tab === 'profile' && <>
        <section className="glass rounded-2xl p-6 space-y-4"><h2 className="text-lg font-semibold">个人资料</h2><p className="text-sm text-muted">面板 ID：<span className="text-white">{config.id}</span></p><p className="text-sm text-muted break-all">绑定邮箱：<span className="text-white">{config.email}</span></p></section>
        <form className="glass rounded-2xl p-6 space-y-4" onSubmit={e => { e.preventDefault(); if (newPassword !== confirmPassword) { setMessage('两次管理密码不一致'); return; } void run(async () => { await panelRequest(`${base}/password`, { oldPassword, password: newPassword, confirmPassword }); setOldPassword(''); setNewPassword(''); setConfirmPassword(''); setConfig(null); setMessage('密码已修改，请重新登录'); }); }}><h2 className="text-lg font-semibold">修改管理密码</h2><Field label="原密码"><input className={inputClass} type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" required /></Field><Field label="新密码"><input className={inputClass} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={8} maxLength={72} pattern={passwordPattern} title={passwordHint} placeholder={passwordHint} autoComplete="new-password" required /></Field><Field label="确认新密码"><input className={inputClass} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} maxLength={72} autoComplete="new-password" required />{confirmPassword && newPassword !== confirmPassword && <span className="text-xs text-red-300">两次管理密码不一致</span>}</Field><button className={buttonClass} disabled={busy}>修改并退出已有登录</button></form>
      </>}
    </div></main>
  </div>;
}
