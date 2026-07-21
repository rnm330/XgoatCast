import { useEffect, useState } from 'react';
import { Settings, ListChecks, LogOut, ShieldCheck, ExternalLink } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, getServerAdminToken, setServerAdminToken, clearServerAdminToken } from '../lib/api';
import { cn } from '../lib/utils';
import { QUALITY_OPTIONS } from '../hooks/useScreenShare';

type Tab = 'config' | 'sessions';

const TABS: { id: Tab; label: string; icon: typeof Settings }[] = [
  { id: 'config', label: '共享配置', icon: Settings },
  { id: 'sessions', label: '会话记录', icon: ListChecks },
];

export default function ServerAdminPage() {
  const { serverId } = useParams<{ serverId: string }>();
  const [searchParams] = useSearchParams();
  const bindToken = searchParams.get('t') || '';
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('config');
  const [serverInfo, setServerInfo] = useState<any>(null);

  useEffect(() => {
    if (!serverId) return;
    // Check if server exists and get status (pass bind token if present)
    api.getServerStatus(serverId, bindToken || undefined)
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
        const adminToken = getServerAdminToken(serverId);
        if (adminToken) {
          api.getServerConfig(serverId)
            .then(() => {
              setAuthed(true);
              setChecking(false);
            })
            .catch(() => {
              clearServerAdminToken(serverId);
              setChecking(false);
            });
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [serverId, bindToken]);

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
    // 未绑定时需要有效的绑定 token
    if (!bindToken || !serverInfo.tokenValid) {
      return <BindTokenRequired guildName={serverInfo.guildName} />;
    }
    return <BindPage serverId={serverId!} guildName={serverInfo.guildName} bindToken={bindToken} onBind={() => window.location.reload()} />;
  }

  if (!authed) {
    return <ServerLoginForm serverId={serverId!} onSuccess={() => setAuthed(true)} />;
  }

  const handleLogout = () => {
    clearServerAdminToken(serverId!);
    setAuthed(false);
  };

  return (
    <div className="min-h-screen flex">
      <aside className="fixed left-0 top-0 bottom-0 w-60 glass-strong flex flex-col py-6 px-4 z-10">
        <div className="flex items-center gap-3 px-2 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-xl">
            🐑
          </div>
          <div>
            <p className="font-bold text-sm leading-tight">Xgoat.Cast</p>
            <p className="text-xs text-dim truncate max-w-[140px]">{serverInfo.guildName || serverId}</p>
            {serverInfo.openId && <p className="text-xs text-dim">公开ID: {serverInfo.openId}</p>}
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
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
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          退出登录
        </button>
      </aside>

      <main className="flex-1 ml-60 p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold gradient-text">
            {TABS.find((t) => t.id === tab)?.label}
          </h1>
        </div>

        {tab === 'config' && <ServerConfigPanel serverId={serverId!} />}
        {tab === 'sessions' && <ServerSessionPanel serverId={serverId!} />}
      </main>
    </div>
  );
}

// ===== Bind Token Required =====

function BindTokenRequired({ guildName }: { guildName: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="glass rounded-2xl p-8 w-full max-w-sm text-center">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-2xl mx-auto mb-3">
          🔒
        </div>
        <h1 className="text-xl font-bold mb-2">需要绑定链接</h1>
        <p className="text-xs text-muted mt-1 mb-4">{guildName || '该服务器'}</p>
        <p className="text-sm text-muted mb-4">
          该服务器的管理面板尚未绑定。请在 KOOK 服务器内发送以下命令获取绑定链接：
        </p>
        <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 mb-4">
          <code className="text-brand-light text-sm font-mono">/xc绑定</code>
        </div>
        <p className="text-xs text-dim">
          仅服务器主可执行此命令，绑定链接 10 分钟内有效
        </p>
      </div>
    </div>
  );
}

// ===== Bind Page =====

function BindPage({ serverId, guildName, bindToken, onBind }: { serverId: string; guildName: string; bindToken: string; onBind: () => void }) {
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
      const res = await api.bindServer(serverId, password, bindToken);
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
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-2xl mx-auto mb-3">
            🐑
          </div>
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

function ServerLoginForm({ serverId, onSuccess }: { serverId: string; onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.serverAdminLogin(serverId, password);
      if (res.ok && res.token) {
        setServerAdminToken(serverId, res.token);
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
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-2xl mx-auto mb-3">
            🐑
          </div>
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

function ServerConfigPanel({ serverId }: { serverId: string }) {
  const [config, setConfig] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getServerConfig(serverId).then(setConfig).catch((e) => setError(e.message));
  }, [serverId]);

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
      await api.updateServerConfig(serverId, config);
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
        <Field
          label="Token 有效期（秒）"
          type="number"
          value={String(config.agoraTokenExpireSec)}
          onChange={(v) => update(['agoraTokenExpireSec'], Number(v))}
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

      <ConfigSection title="会话超时" desc="控制共享链接失效的参数">
        <Field
          label="未共享屏幕超时（秒）"
          type="number"
          value={String(config.idleTimeoutSec)}
          onChange={(v) => update(['idleTimeoutSec'], Number(v))}
        />
        <Field
          label="无人观看超时（秒）"
          type="number"
          value={String(config.noViewerTimeoutSec)}
          onChange={(v) => update(['noViewerTimeoutSec'], Number(v))}
        />
        <Field
          label="心跳间隔（秒）"
          type="number"
          value={String(config.heartbeatIntervalSec)}
          onChange={(v) => update(['heartbeatIntervalSec'], Number(v))}
        />
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
              开启后共享页显示「低延迟模式」开关，默认为普通模式，低延迟模式延迟降低约60-70%，费用上涨约100%
            </p>
          </div>
        </label>
      </ConfigSection>

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

function ServerSessionPanel({ serverId }: { serverId: string }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getServerSessions(serverId)
      .then(setSessions)
      .finally(() => setLoading(false));
  }, [serverId]);

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

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted mb-1 block">{label}</label>
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
