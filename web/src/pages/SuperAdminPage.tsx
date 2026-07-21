import { useEffect, useState } from 'react';
import { Settings, Server, LogOut, ShieldCheck, ExternalLink } from 'lucide-react';
import { api, getSuperAdminToken, clearSuperAdminToken } from '../lib/api';
import { cn } from '../lib/utils';

type Tab = 'config' | 'servers';
type ServerDetailTab = 'events' | 'sessions';

const TABS: { id: Tab; label: string; icon: typeof Settings }[] = [
  { id: 'config', label: '全局配置', icon: Settings },
  { id: 'servers', label: '服务器列表', icon: Server },
];

export default function SuperAdminPage() {
  const [authed, setAuthed] = useState(!!getSuperAdminToken());
  const [checking, setChecking] = useState(!!getSuperAdminToken());
  const [tab, setTab] = useState<Tab>('config');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  useEffect(() => {
    if (!authed) return;
    api.getSuperConfig()
      .then(() => setChecking(false))
      .catch(() => {
        clearSuperAdminToken();
        setAuthed(false);
        setChecking(false);
      });
  }, [authed]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ShieldCheck className="w-8 h-8 text-brand animate-pulse" />
      </div>
    );
  }

  if (!authed) {
    return <SuperLoginForm onSuccess={() => setAuthed(true)} />;
  }

  const handleLogout = () => {
    clearSuperAdminToken();
    setAuthed(false);
  };

  const handleServerSelect = (serverId: string) => {
    setSelectedServerId(serverId);
  };

  const handleBackToList = () => {
    setSelectedServerId(null);
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
            <p className="text-xs text-dim">超级管理后台</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setSelectedServerId(null);
                }}
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

        <div className="space-y-1">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            退出登录
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-60 p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold gradient-text">
            {selectedServerId ? '服务器详情' : TABS.find((t) => t.id === tab)?.label}
          </h1>
        </div>

        {tab === 'config' && <GlobalConfigPanel />}
        {tab === 'servers' && !selectedServerId && (
          <ServerListPanel onSelectServer={handleServerSelect} />
        )}
        {tab === 'servers' && selectedServerId && (
          <ServerDetailPanel serverId={selectedServerId} onBack={handleBackToList} />
        )}
      </main>
    </div>
  );
}

// ===== Login Form =====

function SuperLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.superLogin(password);
      if (res.ok && res.token) {
        localStorage.setItem('xgoat_super_token', res.token);
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
          <h1 className="text-xl font-bold">超级管理后台</h1>
          <p className="text-xs text-muted mt-1">Xgoat.Cast Super Admin</p>
        </div>
        <div className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入超级管理员密码"
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

// ===== Global Config Panel =====

function GlobalConfigPanel() {
  const [config, setConfig] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSuperConfig().then(setConfig);
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.updateSuperConfig(config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-6">
      <div className="glass rounded-2xl p-5">
        <h3 className="font-semibold text-white">KOOK 机器人</h3>
        <p className="text-xs text-muted mb-4 mt-0.5">配置全局机器人 Token</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted mb-1 block">Bot Token</label>
            <input
              type="text"
              value={config.kookBotToken}
              onChange={(e) => setConfig({ ...config, kookBotToken: e.target.value })}
              placeholder="已配置则显示 ******"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">公共域名</label>
            <input
              type="text"
              value={config.publicDomain}
              onChange={(e) => setConfig({ ...config, publicDomain: e.target.value })}
              placeholder="https://your-domain.com"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="btn-brand px-6 py-2.5 rounded-xl text-white font-medium text-sm disabled:opacity-40"
      >
        {saving ? '保存中...' : saved ? '已保存' : '保存配置'}
      </button>
    </div>
  );
}

// ===== Server List Panel =====

function ServerListPanel({ onSelectServer }: { onSelectServer: (serverId: string) => void }) {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadServers = () => {
    setLoading(true);
    api.getSuperServers()
      .then(setServers)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadServers(); }, []);

  if (loading) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-4">
      {servers.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-muted">
          暂无服务器，邀请机器人加入 KOOK 服务器后自动注册
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {servers.map((s) => (
            <div
              key={s.serverId}
              onClick={() => onSelectServer(s.serverId)}
              className={cn(
                'glass rounded-2xl p-5 cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg',
                s.status === 'kicked' && 'opacity-60'
              )}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-white truncate">
                    {s.guildName || '未命名服务器'}
                  </h3>
                  <p className="text-xs text-muted mt-1">公开ID: {s.openId || '-'}</p>
                </div>
                <div className="flex flex-col gap-1.5 ml-2">
                  <span className={cn(
                    'px-2 py-0.5 rounded text-xs font-medium text-center',
                    s.status === 'kicked' 
                      ? 'bg-red-500/20 text-red-300'
                      : s.bound 
                        ? 'bg-green-500/20 text-green-300' 
                        : 'bg-yellow-500/20 text-yellow-300'
                  )}>
                    {s.status === 'kicked' ? '已踢出' : s.bound ? '已绑定' : '未绑定'}
                  </span>
                </div>
              </div>
              
              <div className="space-y-1.5 text-xs text-muted">
                <p>雪花ID: <span className="font-mono">{s.serverId}</span></p>
                <p>管理员: {s.ownerUsername || s.ownerId || '未知'}</p>
                {s.agoraAppId && (
                  <p>Agora: <span className="text-green-400">已配置</span></p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between">
                <span className="text-xs text-dim">
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-1">
                  <a
                    href={`/${s.serverId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="p-1.5 rounded-lg hover:bg-white/5 text-muted hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Server Detail Panel =====

function ServerDetailPanel({ serverId, onBack }: { serverId: string; onBack: () => void }) {
  const [server, setServer] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ServerDetailTab>('events');
  const [triggerWords, setTriggerWords] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [savedConfig, setSavedConfig] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getSuperServer(serverId),
      api.getSuperServerEvents(serverId),
      api.getSuperServerSessions(serverId),
    ])
      .then(([serverData, eventsData, sessionsData]) => {
        setServer(serverData);
        setTriggerWords(serverData.triggerWords || '');
        setEvents(eventsData);
        setSessions(sessionsData);
      })
      .finally(() => setLoading(false));
  }, [serverId]);

  if (loading) return <div className="text-muted text-sm">加载中...</div>;
  if (!server) return <div className="text-red-300">服务器不存在</div>;

  const getEventTypeLabel = (type: string) => {
    switch (type) {
      case 'bot_joined': return { label: '机器人加入', color: 'bg-green-500/20 text-green-300' };
      case 'bot_kicked': return { label: '机器人被踢出', color: 'bg-red-500/20 text-red-300' };
      case 'bot_left': return { label: '机器人离开', color: 'bg-yellow-500/20 text-yellow-300' };
      default: return { label: type, color: 'bg-white/10 text-muted' };
    }
  };

  return (
    <div className="space-y-6">
      {/* 返回按钮和服务器基本信息 */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={onBack}
            className="p-2 rounded-lg hover:bg-white/5 text-muted hover:text-white transition-colors"
          >
            ← 返回列表
          </button>
        </div>
        
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">
              {server.guildName || '未命名服务器'}
            </h2>
            <div className="mt-2 space-y-1 text-sm text-muted">
              <p>公开ID: {server.openId || '-'}</p>
              <p>雪花ID: <span className="font-mono">{server.serverId}</span></p>
              <p>管理员: {server.ownerUsername || server.ownerId || '未知'}</p>
              <p>创建时间: {new Date(server.createdAt).toLocaleString()}</p>
            </div>
          </div>
          
          <div className="flex flex-col gap-2">
            <span className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium text-center',
              server.status === 'kicked' 
                ? 'bg-red-500/20 text-red-300'
                : server.bound 
                  ? 'bg-green-500/20 text-green-300' 
                  : 'bg-yellow-500/20 text-yellow-300'
            )}>
              {server.status === 'kicked' ? '已踢出' : server.bound ? '已绑定' : '未绑定'}
            </span>
            <a
              href={`/${server.serverId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg text-sm text-center bg-white/5 text-muted hover:text-white hover:bg-white/10 transition-colors"
            >
              打开管理面板
            </a>
          </div>
        </div>

        {/* Agora 配置状态 */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <p className="text-sm text-muted">
            Agora App ID: {server.agoraAppId ? (
              <span className="text-green-400">已配置</span>
            ) : (
              <span className="text-yellow-400">未配置</span>
            )}
          </p>
        </div>

        {/* 触发词管理 */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <label className="text-xs text-muted mb-1.5 block">触发词（逗号分隔，用户发送包含触发词的消息将触发屏幕共享）</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={triggerWords}
              onChange={(e) => setTriggerWords(e.target.value)}
              placeholder="屏幕共享,共享屏幕"
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
            <button
              onClick={async () => {
                setSavingConfig(true);
                try {
                  await api.updateSuperServer(serverId, { triggerWords });
                  setSavedConfig(true);
                  setTimeout(() => setSavedConfig(false), 2000);
                } catch (e: any) {
                  alert(e.message || '保存失败');
                } finally {
                  setSavingConfig(false);
                }
              }}
              disabled={savingConfig}
              className="btn-brand px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-40"
            >
              {savingConfig ? '保存中...' : savedConfig ? '已保存' : '保存'}
            </button>
          </div>
        </div>
      </div>

      {/* 选项卡：事件日志 / 会话记录 */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('events')}
          className={cn(
            'px-4 py-2 rounded-xl text-sm font-medium transition-colors',
            activeTab === 'events'
              ? 'bg-brand/15 text-brand-light'
              : 'text-muted hover:text-white hover:bg-white/5'
          )}
        >
          事件日志 ({events.length})
        </button>
        <button
          onClick={() => setActiveTab('sessions')}
          className={cn(
            'px-4 py-2 rounded-xl text-sm font-medium transition-colors',
            activeTab === 'sessions'
              ? 'bg-brand/15 text-brand-light'
              : 'text-muted hover:text-white hover:bg-white/5'
          )}
        >
          会话记录 ({sessions.length})
        </button>
      </div>

      {/* 事件日志 */}
      {activeTab === 'events' && (
        <div className="glass rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-muted">
                <th className="px-4 py-3">事件类型</th>
                <th className="px-4 py-3">操作人</th>
                <th className="px-4 py-3">详情</th>
                <th className="px-4 py-3">时间</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted">暂无事件</td></tr>
              ) : (
                events.map((e) => {
                  const eventType = getEventTypeLabel(e.eventType);
                  return (
                    <tr key={e.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <span className={cn('px-2 py-0.5 rounded text-xs', eventType.color)}>
                          {eventType.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">{e.operatorName || e.operatorId || '-'}</td>
                      <td className="px-4 py-3 text-muted">{e.detail || '-'}</td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {new Date(e.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 会话记录 */}
      {activeTab === 'sessions' && (
        <div className="glass rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-muted">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">分享者</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">观众数</th>
                <th className="px-4 py-3">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">暂无会话</td></tr>
              ) : (
                sessions.map((s) => (
                  <tr key={s.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono text-xs">{s.id.slice(0, 8)}</td>
                    <td className="px-4 py-3">{s.sharerUsername}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'px-2 py-0.5 rounded text-xs',
                        s.status === 'active' ? 'bg-green-500/20 text-green-300' :
                        s.status === 'pending' ? 'bg-yellow-500/20 text-yellow-300' :
                        s.status === 'grace' ? 'bg-orange-500/20 text-orange-300' :
                        'bg-white/10 text-muted'
                      )}>{s.status}</span>
                    </td>
                    <td className="px-4 py-3 text-muted">{s.viewerCount || 0}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
