import { useEffect, useState } from 'react';
import { Settings, ListChecks, LogOut, ShieldCheck, ExternalLink, Copy, Check, Info, MonitorUp } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  clearSpaceAdminToken,
  getSpaceAdminToken,
  setSpaceAdminToken,
  type Platform,
} from '../lib/api';
import { cn } from '../lib/utils';
import { QUALITY_OPTIONS } from '../hooks/useScreenShare';
import { NoticeBanners, NoticeProvider } from '../components/notices/NoticeCenter';
import { getClientEnvironment, getTemporaryAdminBrowserSessionId } from '../lib/clientEnv';

type Tab = 'config' | 'sessions';

const TABS: { id: Tab; label: string; icon: typeof Settings }[] = [
  { id: 'config', label: '共享配置', icon: Settings },
  { id: 'sessions', label: '会话记录', icon: ListChecks },
];

export default function ServerAdminPage() {
  const {
    serverId: legacyServerId,
    platform: routePlatform,
    externalId,
  } = useParams<{ serverId?: string; platform?: string; externalId?: string }>();
  const platform = (routePlatform || 'kook') as Platform;
  const serverId = externalId || legacyServerId;
  const [searchParams] = useSearchParams();
  const bindToken = searchParams.get('t') || '';
  const bindIntent = searchParams.get('bind') || '';
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('config');
  const [serverInfo, setServerInfo] = useState<any>(null);

  useEffect(() => {
    if (!serverId) return;
    // Check if server exists and get status (pass bind token if present)
    api.getSpaceStatus(platform, serverId, bindToken || undefined)
      .then((info) => {
        setServerInfo(info);
        if (!info.exists) {
          setChecking(false);
          return;
        }
        if (!info.bound) {
          setChecking(false);
          return;
        }
        // Check if we have a valid token for this server
        const adminToken = getSpaceAdminToken(platform, serverId);
        if (adminToken) {
          api.getSpaceConfig(platform, serverId)
            .then(() => {
              setAuthed(true);
              setChecking(false);
            })
            .catch(() => {
              clearSpaceAdminToken(platform, serverId);
              setChecking(false);
            });
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [platform, serverId, bindToken]);

  useEffect(() => {
    if (!authed || !serverId) return;
    const heartbeat = () => {
      void api.heartbeatSpacePresence(
        platform,
        serverId,
        getTemporaryAdminBrowserSessionId(),
        getClientEnvironment(),
      ).catch(() => {});
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 30_000);
    return () => window.clearInterval(timer);
  }, [authed, platform, serverId]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ShieldCheck className="w-8 h-8 text-brand animate-pulse" />
      </div>
    );
  }

  if (!serverInfo?.exists) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="glass rounded-2xl p-8 text-center max-w-sm">
          <h2 className="text-xl font-bold mb-2">服务器不存在</h2>
          <p className="text-muted text-sm">请确认服务器 ID 是否正确，或邀请机器人加入服务器。</p>
        </div>
      </div>
    );
  }

  if (!serverInfo.bound) {
    if ((platform === 'heychat' || platform === 'qq') && bindIntent) {
      return (
        <DeviceBindPage
          platform={platform}
          serverId={serverId!}
          guildName={serverInfo.guildName}
          intentId={bindIntent}
          onBind={() => window.location.reload()}
        />
      );
    }
    // 未绑定时需要有效的绑定 token
    if (!bindToken || !serverInfo.tokenValid) {
      return <BindTokenRequired guildName={serverInfo.guildName} platform={platform} />;
    }
    return <BindPage platform={platform} serverId={serverId!} guildName={serverInfo.guildName} bindToken={bindToken} onBind={() => window.location.reload()} />;
  }

  if (!authed) {
    return <ServerLoginForm platform={platform} serverId={serverId!} onSuccess={() => setAuthed(true)} />;
  }

  const handleLogout = () => {
    clearSpaceAdminToken(platform, serverId!);
    setAuthed(false);
  };

  return (
    <NoticeProvider page="server_admin">
    <div className="min-h-screen lg:flex">
      <aside className="w-full lg:w-60 lg:fixed lg:left-0 lg:top-0 lg:bottom-0 glass-strong flex lg:flex-col gap-4 lg:gap-0 px-4 py-4 lg:py-6 z-10">
        <div className="flex shrink-0 items-center gap-3 px-2 lg:mb-8">
          <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center"><MonitorUp size={23} strokeWidth={1.7} /></div>
          <div>
            <p className="font-bold text-sm leading-tight">Xgoat.Cast</p>
            <p className="text-xs text-dim truncate max-w-[140px]">{serverInfo.guildName || serverId}</p>
            {serverInfo.openId && <p className="text-xs text-dim">公开ID: {serverInfo.openId}</p>}
          </div>
        </div>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto lg:block lg:space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'shrink-0 lg:w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                  tab === t.id
                    ? 'bg-brand/15 text-brand-light'
                    : 'text-muted hover:text-white hover:bg-white/5',
                )}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </nav>

        <button
          onClick={handleLogout}
          className="shrink-0 flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          退出登录
        </button>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:ml-60 lg:p-8">
        <NoticeBanners />
        <div className="mb-6">
          <h1 className="text-2xl font-bold gradient-text">
            {TABS.find((t) => t.id === tab)?.label}
          </h1>
        </div>

        {tab === 'config' && <ServerConfigPanel platform={platform} serverId={serverId!} />}
        {tab === 'sessions' && <ServerSessionPanel platform={platform} serverId={serverId!} />}
      </main>
    </div>
    </NoticeProvider>
  );
}

function DeviceBindPage({
  platform,
  serverId,
  guildName,
  intentId,
  onBind,
}: {
  platform: 'heychat' | 'qq';
  serverId: string;
  guildName: string;
  intentId: string;
  onBind: () => void;
}) {
  const manageCommand = platform === 'qq' ? '管理' : '/xchelp';
  const mentionPrefix = platform === 'qq' ? '@XgoatCast屏幕共享机器人 ' : '';
  const fullManageCommand = `${mentionPrefix}${manageCommand}`;
  const [code, setCode] = useState('');
  const [state, setState] = useState<'loading' | 'pending' | 'authorized' | 'expired' | 'unavailable'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API is unavailable outside secure contexts; fall back to a
      // hidden textarea selection.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Copying is a convenience; the command remains visible to type by hand.
      }
      document.body.removeChild(area);
    }
  };

  const bindingCommand = platform === 'qq' ? `${mentionPrefix}${code}` : `${manageCommand} ${code}`;
  const copyCommand = () => copyText(bindingCommand);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const claim = async () => {
      try {
        const intent = await api.getHeychatBindingIntentStatus(serverId, intentId, platform);
        if (!intent.ok || intent.state === 'expired' || intent.state === 'unavailable') {
          if (!cancelled) setState('expired');
          return;
        }
        const claimResult = await api.claimHeychatBinding(serverId, intentId, platform);
        if (!claimResult.ok || !claimResult.code) {
          if (!cancelled) setState('unavailable');
          return;
        }
        if (cancelled) return;
        setCode(claimResult.code);
        setState(claimResult.state === 'authorized' ? 'authorized' : 'pending');

        const poll = async () => {
          try {
            const result = await api.pollHeychatBinding(serverId, intentId, platform);
            if (cancelled) return;
            if (result.state === 'authorized') setState('authorized');
            else if (!result.ok || result.state === 'expired' || result.state === 'revoked') setState('expired');
            else timer = window.setTimeout(poll, 2000);
          } catch {
            if (!cancelled) timer = window.setTimeout(poll, 3000);
          }
        };
        if (claimResult.state !== 'authorized') timer = window.setTimeout(poll, 1000);
      } catch (err: any) {
        if (!cancelled) {
          setState('unavailable');
          setError(err.message || '绑定入口已失效');
        }
      }
    };
    void claim();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [platform, serverId, intentId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError('管理密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次密码不一致');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await api.bindHeychatBinding(serverId, intentId, password, platform);
      if (!result.ok) setError(result.message || '绑定失败');
      else onBind();
    } catch (err: any) {
      setError(err.message || '绑定失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass rounded-2xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mx-auto mb-3"><MonitorUp size={28} strokeWidth={1.7} /></div>
          <h1 className="text-xl font-bold">{platform === 'qq' ? 'QQ群绑定' : '黑盒语音房间绑定'}</h1>
          <p className="text-xs text-muted mt-1">{guildName || serverId}</p>
        </div>
        {state === 'pending' && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted leading-relaxed">{platform === 'qq' ? '复制绑定码，回到群内发送。' : '请确认这是你刚打开的浏览器，点击下方按钮复制绑定码命令，然后到房间内粘贴发送：'}</p>
            <div className="rounded-xl bg-white/5 border border-brand/30 px-4 py-4 space-y-3">
              {platform === 'qq' && (
                <div className="flex items-center justify-center gap-1.5 text-xs text-muted">
                  <span className="inline-flex items-center rounded-full border border-brand/20 bg-brand/10 px-2.5 py-1 text-brand-light">@XgoatCast</span>
                  <span>屏幕共享机器人</span>
                </div>
              )}
              <code className={cn('block text-brand-light font-mono text-center', platform === 'qq' ? 'text-3xl tracking-[0.16em] py-2' : 'text-2xl tracking-[0.15em] break-all')}>
                {platform === 'qq' ? code : `${manageCommand} ${code}`}
              </code>
              <button type="button" onClick={copyCommand} className="btn-brand w-full py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2">
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? '已复制' : '复制绑定码'}
              </button>
              {platform === 'qq' && <p className="text-[11px] text-dim">已包含完整 @名称，粘贴后请确认已正确提及机器人</p>}
            </div>
            <p className="text-xs text-dim">{platform === 'qq' ? '群主或管理员操作 · 5 分钟内有效' : '绑定码 5 分钟内有效。'}</p>
            <p className="text-xs text-dim">发送后回到此页面，继续设置管理密码</p>
          </div>
        )}
        {state === 'authorized' && (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-green-300">设备已授权，请设置管理密码。</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white" autoFocus />
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入管理密码" className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white" />
            {error && <p className="text-sm text-red-300">{error}</p>}
            <button type="submit" disabled={submitting} className="w-full btn-brand py-2.5 rounded-xl text-white font-medium text-sm disabled:opacity-40">{submitting ? '绑定中...' : '完成绑定'}</button>
          </form>
        )}
        {(state === 'loading') && <p className="text-sm text-muted text-center">正在创建本浏览器的独立设备凭证…</p>}
        {(state === 'expired' || state === 'unavailable') && (error ? (
          <p className="text-sm text-red-300 text-center">{error}</p>
        ) : (
          <div className="space-y-4 text-center">
            <p className="text-sm text-red-300">{platform === 'qq' ? '绑定入口已失效，请群主或管理员复制下方完整命令，回到群内重新获取入口：' : '绑定入口已失效，请让房主在房间内发送以下命令重新获取入口：'}</p>
            <div className="rounded-xl bg-white/5 border border-brand/30 px-4 py-4 space-y-3 select-none">
              <code className="block text-2xl tracking-[0.15em] text-brand-light font-mono text-center select-none" aria-hidden="true">
                {platform === 'qq' && <span className="block text-xs tracking-normal text-muted mb-3">@XgoatCast 屏幕共享机器人</span>}
                {manageCommand}
              </code>
              <button
                type="button"
                onClick={() => copyText(fullManageCommand)}
                className="btn-brand w-full py-2.5 rounded-lg text-sm font-medium"
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== Bind Token Required =====

function BindTokenRequired({ guildName, platform }: { guildName: string; platform: Platform }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass rounded-2xl p-8 w-full max-w-sm text-center">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-2xl mx-auto mb-3">
          🔒
        </div>
        <h1 className="text-xl font-bold mb-2">需要绑定链接</h1>
        <p className="text-xs text-muted mt-1 mb-4">{guildName || '该服务器'}</p>
        <p className="text-sm text-muted mb-4">
          该服务器的管理面板尚未绑定。{platform === 'qq' && '请先在QQ群里 @机器人。'}请在{platform === 'qq' ? 'QQ群' : platform === 'heychat' ? '小黑盒房间' : ' KOOK 服务器'}内发送以下命令获取绑定链接：
        </p>
        <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 mb-4">
          <code className="text-brand-light text-sm font-mono">{platform === 'qq' ? '管理' : '/xchelp'}</code>
        </div>
        <p className="text-xs text-dim">
          {platform === 'qq' ? '群主和管理员可执行此命令，绑定入口 10 分钟内有效' : '仅服务器主可执行此命令，绑定链接 10 分钟内有效'}
        </p>
      </div>
    </div>
  );
}

// ===== Bind Page =====

function BindPage({ platform, serverId, guildName, bindToken, onBind }: { platform: Platform; serverId: string; guildName: string; bindToken: string; onBind: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('两次密码不一致');
      return;
    }
    if (password.length < 6) {
      setError('密码至少6位');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.bindSpace(platform, serverId, password, bindToken);
      if (res.ok) {
        onBind();
      } else {
        setError(res.message || '绑定失败');
      }
    } catch (err: any) {
      setError(err.message || '网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="glass rounded-2xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mx-auto mb-3"><MonitorUp size={28} strokeWidth={1.7} /></div>
          <h1 className="text-xl font-bold">绑定管理面板</h1>
          <p className="text-xs text-muted mt-1">{guildName || serverId}</p>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted mb-1 block">设置管理密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少6位"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">确认密码</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full btn-brand py-2.5 rounded-xl text-white font-medium text-sm disabled:opacity-40"
          >
            {loading ? '绑定中...' : '绑定管理面板'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ===== Login Form =====

function ServerLoginForm({ platform, serverId, onSuccess }: { platform: Platform; serverId: string; onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.spaceAdminLogin(platform, serverId, password);
      if (res.ok && res.token) {
        setSpaceAdminToken(platform, serverId, res.token);
        onSuccess();
      } else {
        setError(res.message || '登录失败');
      }
    } catch (err: any) {
      setError(err.message || '网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={handleSubmit} className="glass rounded-2xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mx-auto mb-3"><MonitorUp size={28} strokeWidth={1.7} /></div>
          <h1 className="text-xl font-bold">服务器管理面板</h1>
          <p className="text-xs text-muted mt-1">ID: {serverId}</p>
        </div>
        <div className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入管理密码"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            autoFocus
          />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full btn-brand py-2.5 rounded-xl text-white font-medium text-sm disabled:opacity-40"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ===== Server Config Panel =====

function ServerConfigPanel({ platform, serverId }: { platform: Platform; serverId: string }) {
  const [config, setConfig] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSpaceConfig(platform, serverId).then(setConfig).catch((e) => setError(e.message));
  }, [platform, serverId]);

  const update = (path: string[], value: unknown) => {
    setConfig((c: any) => {
      if (!c) return c;
      const next = JSON.parse(JSON.stringify(c));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError('');
    try {
      await api.updateSpaceConfig(platform, serverId, config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-6">
      <ConfigSection title="声网 Agora" desc="配置本服务器的声网凭证">
        <p className="text-xs text-dim -mt-1">
          支持 agora.io 国际站和 shengwang.cn 声网国内站的账户，系统会自动匹配，无论是哪个站点的账户，均不会影响屏幕共享的速率和清晰度。
        </p>
        <Field
          label="App ID"
          value={config.agoraAppId}
          onChange={(v) => update(['agoraAppId'], v)}
          placeholder="如 8a3c..."
        />
        <Field
          label="App Certificate"
          value={config.agoraAppCertificate}
          onChange={(v) => update(['agoraAppCertificate'], v)}
          placeholder="已配置则显示 ******"
        />
        <div>
          <label className="text-xs text-muted mb-2 block">允许的画质</label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {QUALITY_OPTIONS.map((q: any) => {
              const checked = (config.allowedQualities || []).includes(q.key);
              return (
                <label
                  key={q.key}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                    checked
                      ? 'border-brand/40 bg-brand/10 text-white'
                      : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...(config.allowedQualities || []), q.key]
                        : (config.allowedQualities || []).filter((k: string) => k !== q.key);
                      update(['allowedQualities'], next.length > 0 ? next : [q.key]);
                    }}
                    className="accent-brand"
                  />
                  {q.label}
                </label>
              );
            })}
          </div>
        </div>
      </ConfigSection>

      <ConfigSection title="会话关闭时间" desc="控制共享链接自动关闭的时间，最长 600 秒">
        <Field
          label="停止共享关闭时间（秒）"
          hint="如果未开始共享，或共享被停止，多长时间后关闭共享链接，最长600秒。"
          type="number"
          value={String(config.idleTimeoutSec)}
          onChange={(v) => update(['idleTimeoutSec'], Number(v))}
        />
        <Field
          label="无人观看关闭时间（秒）"
          hint="共享无观众观看，多长时间后关闭共享链接，最长600秒。"
          type="number"
          value={String(config.noViewerTimeoutSec)}
          onChange={(v) => update(['noViewerTimeoutSec'], Number(v))}
        />
      </ConfigSection>

      <ConfigSection title="画面优先策略" desc="控制共享者能否选择画质优先或帧率优先，默认开放">
        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 cursor-pointer">
          <input
            type="checkbox"
            checked={!!config.allowQualityPreference}
            onChange={(e) => update(['allowQualityPreference'], e.target.checked ? 1 : 0)}
            className="accent-brand mt-1"
          />
          <div>
            <p className="text-sm font-medium">允许共享者切换画面优先策略</p>
            <p className="text-xs text-muted mt-1 leading-relaxed">开启后可在共享前选择画质优先或帧率优先；关闭后选项不可操作，统一使用帧率优先。</p>
          </div>
        </label>
      </ConfigSection>

      <ConfigSection title="直播模式" desc="控制共享页的直播模式选项">
        <label
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors text-sm',
            config.allowLowLatency
              ? 'border-blue-500/40 bg-blue-500/10 text-white'
              : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
          )}
        >
          <input
            type="checkbox"
            checked={!!config.allowLowLatency}
            onChange={(e) => update(['allowLowLatency'], e.target.checked ? 1 : 0)}
            className="accent-brand"
          />
          <div>
            <p className="font-medium">允许共享者开启低延迟模式</p>
            <p className="text-xs text-dim mt-0.5">
              共享页始终显示「低延迟模式」开关；此权限控制能否开启，默认关闭。低延迟模式的视频计费消耗约为极速直播的 2 倍，实际网络流量取决于码率与时长。
            </p>
          </div>
        </label>
      </ConfigSection>

      {platform !== 'heychat' && (
        <ConfigSection title="触发词" desc="选择本服务器允许使用的全局触发词标签">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {(config.triggerWordLabels || []).map((word: string) => {
              const checked = (config.enabledTriggerWords || []).includes(word);
              return (
                <label
                  key={word}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                    checked
                      ? 'border-brand/40 bg-brand/10 text-white'
                      : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const current = config.enabledTriggerWords || [];
                      const next = e.target.checked
                        ? [...current, word]
                        : current.filter((item: string) => item !== word);
                      if (next.length > 0) update(['enabledTriggerWords'], next);
                    }}
                    className="accent-brand"
                  />
                  {word}
                </label>
              );
            })}
          </div>
          <p className="text-xs text-dim mt-2">至少启用一个触发词。</p>
        </ConfigSection>
      )}

      {error && (
        <p className="text-sm text-red-300 bg-red-500/10 rounded-lg px-4 py-2">{error}</p>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="btn-brand px-6 py-2.5 rounded-xl text-white font-medium text-sm flex items-center gap-2 disabled:opacity-40"
      >
        {saving ? '保存中...' : saved ? '已保存' : '保存配置'}
      </button>
    </div>
  );
}

// ===== Server Session Panel =====

function ServerSessionPanel({ platform, serverId }: { platform: Platform; serverId: string }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSpaceSessions(platform, serverId)
      .then(setSessions)
      .finally(() => setLoading(false));
  }, [platform, serverId]);

  if (loading) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-muted">
            <th className="px-4 py-3">ID</th>
            <th className="px-4 py-3">分享者</th>
            <th className="px-4 py-3">画质</th>
            <th className="px-4 py-3">状态</th>
            <th className="px-4 py-3">观众</th>
            <th className="px-4 py-3">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">暂无会话</td></tr>
          ) : (
            sessions.map((s) => (
              <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                <td className="px-4 py-3 font-mono text-xs">{s.id.slice(0, 8)}</td>
                <td className="px-4 py-3">{s.sharerUsername}</td>
                <td className="px-4 py-3 text-xs">{s.quality}</td>
                <td className="px-4 py-3">
                  <span className={cn(
                    'px-2 py-0.5 rounded text-xs',
                    s.status === 'active' ? 'bg-green-500/20 text-green-300' :
                    s.status === 'pending' ? 'bg-yellow-500/20 text-yellow-300' :
                    s.status === 'grace' ? 'bg-orange-500/20 text-orange-300' :
                    'bg-white/10 text-muted'
                  )}>{s.status}</span>
                </td>
                <td className="px-4 py-3 text-xs">{s.viewerCount}/{s.peakViewers}</td>
                <td className="px-4 py-3 text-xs text-muted">
                  {new Date(s.createdAt).toLocaleString()}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ===== Helper Components =====

function ConfigSection({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="text-xs text-muted mb-4 mt-0.5">{desc}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; hint?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted mb-1 inline-flex items-center gap-1.5">
        {label}
        {hint && (
          <span className="relative inline-flex group">
            <Info className="w-3.5 h-3.5 text-dim cursor-help" aria-label={hint} />
            <span className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-white/10 bg-[#1c2237] px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
              {hint}
            </span>
          </span>
        )}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50 transition-colors"
      />
    </div>
  );
}
