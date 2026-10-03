import PanelsPanel from '../components/super-admin/PanelsPanel';
import MailSettingsPanel from '../components/super-admin/MailSettingsPanel';
import { useEffect, useState } from 'react';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Edit3,
  ExternalLink,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MonitorUp,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api, getSuperAdminToken, clearSuperAdminToken, type Platform } from '../lib/api';
import { cn } from '../lib/utils';
import DashboardPanel, { type DashboardRecordTarget } from '../components/super-admin/DashboardPanel';
import RecordsPanel from '../components/super-admin/RecordsPanel';
import { PlatformBadge } from '../components/super-admin/PlatformBadge';
import { QqSettingsPanel } from '../components/super-admin/QqSettingsPanel';

type Tab = 'dashboard' | 'records' | 'config' | 'spaces' | 'notices' | 'panels';
type ServerDetailTab = 'events' | 'sessions';
type SpaceTarget = { platform: Platform; externalId: string };

const TABS: { id: Tab; label: string; icon: typeof Settings }[] = [
  { id: 'dashboard', label: '数据看板', icon: LayoutDashboard },
  { id: 'records', label: '统计记录', icon: ListChecks },
  { id: 'config', label: '全局配置', icon: Settings },
  { id: 'panels', label: '自建面板', icon: Server },
  { id: 'spaces', label: '平台空间', icon: Server },
  { id: 'notices', label: '通知管理', icon: Bell },
];

export default function SuperAdminPage() {
  const [authed, setAuthed] = useState(!!getSuperAdminToken());
  const [checking, setChecking] = useState(!!getSuperAdminToken());
  const [tab, setTab] = useState<Tab>('dashboard');
  const [selectedSpace, setSelectedSpace] = useState<SpaceTarget | null>(null);
  const [recordTarget, setRecordTarget] = useState<DashboardRecordTarget | null>(null);

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

  const handleServerSelect = (space: SpaceTarget) => {
    setSelectedSpace(space);
  };

  const handleBackToList = () => {
    setSelectedSpace(null);
  };

  const handleOpenRecords = (target: DashboardRecordTarget) => {
    setRecordTarget(target);
    setSelectedSpace(null);
    setTab('records');
  };

  return (
    <div className="min-h-screen lg:flex">
      <aside className="w-full lg:w-60 lg:fixed lg:left-0 lg:top-0 lg:bottom-0 glass-strong flex lg:flex-col gap-4 lg:gap-0 px-4 py-4 lg:py-6 z-10">
        <div className="flex shrink-0 items-center gap-3 px-2 lg:mb-8">
          <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center"><MonitorUp size={23} strokeWidth={1.7} /></div>
          <div>
            <p className="font-bold text-sm leading-tight">Xgoat.Cast</p>
            <p className="text-xs text-dim">超级管理后台</p>
          </div>
        </div>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto lg:block lg:space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setSelectedSpace(null);
                  if (t.id !== 'records') setRecordTarget(null);
                }}
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

        <div className="space-y-1">
          <button
            onClick={handleLogout}
            className="shrink-0 flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            退出登录
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:ml-60 lg:p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold gradient-text">
            {selectedSpace ? '空间详情' : TABS.find((t) => t.id === tab)?.label}
          </h1>
        </div>

        {tab === 'dashboard' && <DashboardPanel onOpenRecords={handleOpenRecords} />}
        {tab === 'records' && <RecordsPanel initialTarget={recordTarget} />}
        {tab === 'config' && <div className="space-y-6"><QqSettingsPanel /><GlobalConfigPanel /><MailSettingsPanel /></div>}
        {tab === 'spaces' && !selectedSpace && (
          <ServerListPanel onSelectServer={handleServerSelect} />
        )}
        {tab === 'spaces' && selectedSpace && (
          <ServerDetailPanel space={selectedSpace} onBack={handleBackToList} />
        )}
        {tab === 'panels' && <PanelsPanel />}
        {tab === 'notices' && <NoticeManagementPanel />}
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
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mx-auto mb-3"><MonitorUp size={28} strokeWidth={1.7} /></div>
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
  const [initialHeychat, setInitialHeychat] = useState({ botId: '', tokenConfigured: false });
  const [heychatStatus, setHeychatStatus] = useState<any>(null);
  const [newTriggerWord, setNewTriggerWord] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSuperConfig().then((value) => {
      setConfig(value);
      setInitialHeychat({ botId: value.heychatBotId || '', tokenConfigured: value.heychatBotToken === '******' });
    });
    api.getHeychatStatus().then(setHeychatStatus).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const shouldReloadHeychat = config.heychatBotToken !== '******'
        || config.heychatBotId !== initialHeychat.botId;
      await api.updateSuperConfig(config);
      if (shouldReloadHeychat) {
        const status = await api.syncHeychat();
        if (!status.ok) throw new Error(status.sync?.error || '小黑盒同步失败');
        const latest = await api.getHeychatStatus();
        setHeychatStatus((current: any) => ({
          ...current,
          ...latest,
          rooms: status.rooms,
        }));
        setConfig((current: any) => ({ ...current, heychatBotToken: '******' }));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <div className="text-muted text-sm">加载中...</div>;

  const updateBitrate = (
    qualityKey: string,
    field: 'bitrateMin' | 'bitrateMax',
    rawValue: string,
  ) => {
    const value = rawValue === '' ? undefined : Number(rawValue);
    setConfig((current: any) => ({
      ...current,
      qualityBitrates: {
        ...(current.qualityBitrates || {}),
        [qualityKey]: {
          ...(current.qualityBitrates?.[qualityKey] || {}),
          [field]: value,
        },
      },
    }));
  };

  return (
    <div className="space-y-6">
      <div className="glass rounded-2xl p-5">
        <h3 className="font-semibold text-white">KOOK 机器人</h3>
        <p className="text-xs text-muted mb-4 mt-0.5">配置 KOOK HTTP API 与 WebHook 回调凭证</p>
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
            <label className="text-xs text-muted mb-1 block">Verify Token</label>
            <input
              type="password"
              value={config.kookVerifyToken || ''}
              onChange={(e) => setConfig({ ...config, kookVerifyToken: e.target.value })}
              placeholder="KOOK 开发者后台的 Verify Token"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Encrypt Key</label>
            <input
              type="password"
              value={config.kookEncryptKey || ''}
              onChange={(e) => setConfig({ ...config, kookEncryptKey: e.target.value })}
              placeholder="KOOK WebHook 消息加密密钥"
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
          <div className="rounded-lg bg-white/5 px-3.5 py-3 text-xs text-muted">
            <p>Callback URL</p>
            <p className="mt-1 break-all text-white">
              {(config.publicDomain || '').replace(/\/+$/, '')}/api/integrations/kook/webhook?compress=0
            </p>
            <p className="mt-2 text-amber-300">修改 Bot Token 后需要重启服务；Verify Token 和 Encrypt Key 保存后立即用于回调校验。</p>
          </div>
        </div>
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="font-semibold text-white">小黑盒机器人</h3>
        <p className="text-xs text-muted mb-4 mt-0.5">
          独立 WebSocket 接入；保存新令牌后会热重连并同步已加入的房间
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted mb-1 block">机器人 ID</label>
            <input
              type="text"
              inputMode="numeric"
              value={config.heychatBotId || ''}
              onChange={(e) => setConfig({ ...config, heychatBotId: e.target.value.replace(/\D/g, '') })}
              placeholder="开发者后台中的机器人 ID"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">机器人令牌</label>
            <input
              type="password"
              value={config.heychatBotToken || ''}
              onChange={(e) => setConfig({ ...config, heychatBotToken: e.target.value })}
              placeholder="已配置则显示 ******"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
            />
          </div>
          <div className="rounded-lg bg-white/5 px-3.5 py-3 text-xs text-muted flex items-center justify-between gap-3">
            <div>
              <p>
                状态：
                <span className={heychatStatus?.websocket?.connected ? 'text-green-300' : 'text-yellow-300'}>
                  {heychatStatus?.websocket?.connected ? ' WebSocket 已连接' : heychatStatus?.configured ? ' 待连接' : ' 未配置'}
                </span>
              </p>
              <p className="mt-1">已同步房间：{heychatStatus?.rooms ?? 0}</p>
              <p className="mt-1">卡片待补发：{heychatStatus?.cardDelivery?.pending ?? 0}；待核查：{(heychatStatus?.cardDelivery?.uncertain ?? 0) + (heychatStatus?.cardDelivery?.failed ?? 0)}</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  const status = await api.syncHeychat();
                  if (!status.ok) throw new Error(status.sync?.error || '同步失败');
                  const latest = await api.getHeychatStatus();
                  setHeychatStatus({ ...latest, rooms: status.rooms });
                } catch (e: any) {
                  alert(e.message || '同步失败');
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-white/5 text-white hover:bg-white/10"
            >
              重连并同步
            </button>
          </div>
          <p className="text-xs text-amber-300">
            令牌仅由服务端保存；浏览器读取配置时只会得到 ******。
          </p>
        </div>
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="font-semibold text-white">触发词标签库</h3>
        <p className="text-xs text-muted mt-0.5 mb-4">
          超管维护可用标签；各服务器管理员只能从这里选择要启用的触发词。
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {(config.triggerWordLabels || []).map((word: string) => (
            <span key={word} className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1.5 text-sm text-brand-light">
              {word}
              <button
                type="button"
                onClick={() => setConfig({
                  ...config,
                  triggerWordLabels: config.triggerWordLabels.filter((item: string) => item !== word),
                })}
                className="text-muted hover:text-red-300"
                aria-label={`删除触发词 ${word}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newTriggerWord}
            onChange={(e) => setNewTriggerWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const word = newTriggerWord.trim();
              if (!word || config.triggerWordLabels.includes(word)) return;
              setConfig({ ...config, triggerWordLabels: [...config.triggerWordLabels, word] });
              setNewTriggerWord('');
            }}
            placeholder="输入新触发词"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
          />
          <button
            type="button"
            onClick={() => {
              const word = newTriggerWord.trim();
              if (!word || config.triggerWordLabels.includes(word)) return;
              setConfig({ ...config, triggerWordLabels: [...config.triggerWordLabels, word] });
              setNewTriggerWord('');
            }}
            className="btn-brand px-4 py-2 rounded-lg text-white text-sm inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 添加
          </button>
        </div>
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="font-semibold text-white">画质与码率</h3>
        <p className="text-xs text-muted mt-0.5">
          码率单位为 Kbps；任一字段留空即不向 Agora 传递该项，由 SDK 与浏览器自行协商。
        </p>
        <p className="text-xs text-dim mt-1 mb-4">
          费率按分辨率档位和直播模式自动计算，与手动设置的码率无关。主播基础费率：
          {Number(config.broadcasterHourlyRate || 0).toFixed(2)} 元/小时。
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-muted">
                <th className="px-3 py-2">画质</th>
                <th className="px-3 py-2">分辨率 / 帧率</th>
                <th className="px-3 py-2">最低码率</th>
                <th className="px-3 py-2">最高码率</th>
                <th className="px-3 py-2">互动视频</th>
                <th className="px-3 py-2">极速直播</th>
              </tr>
            </thead>
            <tbody>
              {(config.qualityProfiles || []).map((profile: any) => {
                const bitrate = config.qualityBitrates?.[profile.key] || {};
                return (
                  <tr key={profile.key} className="border-b border-white/5">
                    <td className="px-3 py-3 font-medium text-white">{profile.label}</td>
                    <td className="px-3 py-3 text-muted">
                      {profile.width}×{profile.height} / {profile.frameRate}fps
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="1"
                        step="100"
                        value={bitrate.bitrateMin ?? ''}
                        onChange={(e) => updateBitrate(profile.key, 'bitrateMin', e.target.value)}
                        placeholder="自动"
                        className="w-28 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="1"
                        step="100"
                        value={bitrate.bitrateMax ?? ''}
                        onChange={(e) => updateBitrate(profile.key, 'bitrateMax', e.target.value)}
                        placeholder="自动"
                        className="w-28 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-dim focus:outline-none focus:border-brand/50"
                      />
                    </td>
                    <td className="px-3 py-3 text-blue-300">
                      {Number(profile.interactiveViewerHourlyRate).toFixed(2)} 元/观众小时
                    </td>
                    <td className="px-3 py-3 text-green-300">
                      {Number(profile.liveViewerHourlyRate).toFixed(2)} 元/观众小时
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

// ===== Notice Management Panel =====

type NoticeTarget = 'server_admin' | 'share' | 'view';

interface NoticeFormValue {
  id?: string;
  kind: 'banner' | 'modal';
  modalPolicy: 'dismissible' | 'acknowledgement_required';
  title: string;
  contentFormat: 'text' | 'html';
  content: string;
  imageUrl: string;
  enabled: boolean;
  sortOrder: number;
  repeatAfterSec: number | null;
  targets: NoticeTarget[];
}

const NOTICE_TARGET_LABELS: Record<NoticeTarget, string> = {
  server_admin: '管理页',
  share: '分享页',
  view: '观看页',
};

function emptyNotice(sortOrder: number): NoticeFormValue {
  return {
    kind: 'banner',
    modalPolicy: 'dismissible',
    title: '',
    contentFormat: 'text',
    content: '',
    imageUrl: '',
    enabled: true,
    sortOrder,
    repeatAfterSec: 7 * 24 * 60 * 60,
    targets: ['view'],
  };
}

function NoticeManagementPanel() {
  const [notices, setNotices] = useState<any[]>([]);
  const [editing, setEditing] = useState<NoticeFormValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.getSuperNotices()
      .then(setNotices)
      .catch((e) => alert(e.message || '通知加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const startEdit = (notice: any) => {
    setEditing({
      id: notice.id,
      kind: notice.kind,
      modalPolicy: notice.modalPolicy || 'dismissible',
      title: notice.title || '',
      contentFormat: notice.contentFormat,
      content: notice.content || '',
      imageUrl: notice.imageUrl || '',
      enabled: !!notice.enabled,
      sortOrder: notice.sortOrder,
      repeatAfterSec: notice.repeatAfterSec ?? null,
      targets: [...notice.targets],
    });
  };

  const save = async () => {
    if (!editing) return;
    if (editing.targets.length === 0) {
      alert('至少选择一个投放页面');
      return;
    }
    if (!editing.content.trim() && !editing.imageUrl.trim()) {
      alert('通知正文和图片不能同时为空');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...editing,
        modalPolicy: editing.kind === 'modal' ? editing.modalPolicy : null,
      };
      if (editing.id) {
        await api.updateSuperNotice(editing.id, payload);
      } else {
        await api.createSuperNotice(payload);
      }
      setEditing(null);
      load();
    } catch (e: any) {
      alert(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= notices.length) return;
    const next = [...notices];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setNotices(next);
    try {
      await api.reorderSuperNotices(next.map(notice => notice.id));
    } catch (e: any) {
      alert(e.message || '排序失败');
      load();
    }
  };

  if (loading) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">
            管理横幅和强提醒；旧 KOOK 地址迁移页不受这里控制。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(emptyNotice(notices.length))}
          className="btn-brand px-4 py-2 rounded-xl text-sm inline-flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          新建通知
        </button>
      </div>

      {editing && (
        <div className="glass rounded-2xl p-5 border border-brand/20 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{editing.id ? '编辑通知' : '新建通知'}</h3>
            <button onClick={() => setEditing(null)} className="p-1.5 text-dim hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-xs text-muted">
              通知类型
              <select
                value={editing.kind}
                onChange={(e) => setEditing({ ...editing, kind: e.target.value as NoticeFormValue['kind'] })}
                className="mt-1 w-full bg-surface-dark border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
              >
                <option value="banner">横幅</option>
                <option value="modal">强提醒</option>
              </select>
            </label>
            {editing.kind === 'modal' && (
              <label className="text-xs text-muted">
                关闭策略
                <select
                  value={editing.modalPolicy}
                  onChange={(e) => setEditing({
                    ...editing,
                    modalPolicy: e.target.value as NoticeFormValue['modalPolicy'],
                  })}
                  className="mt-1 w-full bg-surface-dark border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
                >
                  <option value="dismissible">普通提醒（可关闭）</option>
                  <option value="acknowledgement_required">必须确认（仅确认按钮）</option>
                </select>
              </label>
            )}
            <label className="text-xs text-muted">
              标题（可选）
              <input
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
              />
            </label>
            <label className="text-xs text-muted">
              内容格式
              <select
                value={editing.contentFormat}
                onChange={(e) => setEditing({
                  ...editing,
                  contentFormat: e.target.value as NoticeFormValue['contentFormat'],
                })}
                className="mt-1 w-full bg-surface-dark border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
              >
                <option value="text">纯文本</option>
                <option value="html">安全 HTML</option>
              </select>
            </label>
          </div>

          <label className="text-xs text-muted block">
            通知正文
            <textarea
              rows={editing.contentFormat === 'html' ? 8 : 4}
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              placeholder={editing.contentFormat === 'html' ? '<p>通知内容</p>' : '通知内容'}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white font-mono"
            />
          </label>

          <label className="text-xs text-muted block">
            图片 URL（可选，仅 HTTP/HTTPS）
            <input
              value={editing.imageUrl}
              onChange={(e) => setEditing({ ...editing, imageUrl: e.target.value })}
              placeholder="https://..."
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
            />
          </label>

          <div>
            <p className="text-xs text-muted mb-2">投放页面</p>
            <div className="flex flex-wrap gap-4">
              {(Object.keys(NOTICE_TARGET_LABELS) as NoticeTarget[]).map(target => (
                <label key={target} className="inline-flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={editing.targets.includes(target)}
                    onChange={(e) => setEditing({
                      ...editing,
                      targets: e.target.checked
                        ? [...editing.targets, target]
                        : editing.targets.filter(item => item !== target),
                    })}
                  />
                  {NOTICE_TARGET_LABELS[target]}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-xs text-muted">
              关闭后再次提醒
              <select
                value={editing.repeatAfterSec === null ? 'never' : String(editing.repeatAfterSec)}
                onChange={(e) => setEditing({
                  ...editing,
                  repeatAfterSec: e.target.value === 'never' ? null : Number(e.target.value),
                })}
                className="mt-1 w-full bg-surface-dark border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white"
              >
                <option value="0">每次重新进入</option>
                <option value="86400">1 天</option>
                <option value="259200">3 天</option>
                <option value="604800">7 天</option>
                <option value="2592000">30 天</option>
                <option value="never">内容更新前不再提醒</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-muted self-end pb-3">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              启用通知
            </label>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-white/5">
              取消
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="btn-brand px-5 py-2 rounded-lg text-sm disabled:opacity-40"
            >
              {saving ? '保存中...' : '保存通知'}
            </button>
          </div>
        </div>
      )}

      {notices.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-muted">暂无通知</div>
      ) : (
        <div className="space-y-3">
          {notices.map((notice, index) => (
            <div key={notice.id} className="glass rounded-2xl p-5">
              <div className="flex items-start gap-4">
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="p-1 rounded text-dim hover:text-white disabled:opacity-20"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => move(index, 1)}
                    disabled={index === notices.length - 1}
                    className="p-1 rounded text-dim hover:text-white disabled:opacity-20"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{notice.title || '无标题通知'}</h3>
                    <span className="px-2 py-0.5 rounded bg-brand/15 text-brand-light text-xs">
                      {notice.kind === 'banner' ? '横幅' : notice.modalPolicy === 'acknowledgement_required' ? '必须确认' : '普通强提醒'}
                    </span>
                    <span className={cn(
                      'px-2 py-0.5 rounded text-xs',
                      notice.enabled ? 'bg-green-500/15 text-green-300' : 'bg-white/10 text-dim',
                    )}>
                      {notice.enabled ? '启用' : '停用'}
                    </span>
                    <span className="text-xs text-dim">版本 {notice.revision}</span>
                  </div>
                  <p className="text-sm text-muted mt-2 line-clamp-2">
                    {notice.contentFormat === 'html'
                      ? notice.content.replace(/<[^>]*>/g, ' ')
                      : notice.content}
                  </p>
                  <p className="text-xs text-dim mt-2">
                    页面：{notice.targets.map((target: NoticeTarget) => NOTICE_TARGET_LABELS[target]).join('、')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={async () => {
                      await api.republishSuperNotice(notice.id);
                      load();
                    }}
                    title="重新推送"
                    className="p-2 rounded-lg text-muted hover:text-white hover:bg-white/5"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => startEdit(notice)}
                    title="编辑"
                    className="p-2 rounded-lg text-muted hover:text-white hover:bg-white/5"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`确定删除通知“${notice.title || '无标题通知'}”吗？`)) return;
                      await api.deleteSuperNotice(notice.id);
                      load();
                    }}
                    title="删除"
                    className="p-2 rounded-lg text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Server List Panel =====

function spaceAdminHref(platform: Platform, externalId: string): string {
  return platform === 'kook'
    ? `/kook/${encodeURIComponent(externalId)}`
    : `/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`;
}

function ServerListPanel({ onSelectServer }: { onSelectServer: (space: SpaceTarget) => void }) {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadServers = () => {
    setLoading(true);
    api.getSuperSpaces()
      .then(setServers)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadServers(); }, []);

  if (loading) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-4">
      {servers.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-muted">
          暂无平台空间，邀请 KOOK 或小黑盒机器人加入后会自动注册
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {servers.map((s) => (
            <div
              key={`${s.platform}:${s.externalId}`}
              onClick={() => onSelectServer({
                platform: s.platform as Platform,
                externalId: s.externalId,
              })}
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
                  <div className="mt-1"><PlatformBadge platform={s.platform} /></div>
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
                <p>平台空间ID: <span className="font-mono">{s.externalId}</span></p>
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
                    href={spaceAdminHref(s.platform, s.externalId)}
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

function ServerDetailPanel({ space, onBack }: { space: SpaceTarget; onBack: () => void }) {
  const [server, setServer] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ServerDetailTab>('events');
  const [deleting, setDeleting] = useState(false);
  const [advanced, setAdvanced] = useState({ heartbeatIntervalSec: 5, agoraTokenExpireSec: 3600 });
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  const [advancedSaved, setAdvancedSaved] = useState(false);
  const [advancedError, setAdvancedError] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getSuperSpace(space.platform, space.externalId),
      api.getSuperSpaceEvents(space.platform, space.externalId),
      api.getSuperSpaceSessions(space.platform, space.externalId),
    ])
      .then(([serverData, eventsData, sessionsData]) => {
        setServer(serverData);
        setEvents(eventsData);
        setSessions(sessionsData);
        setAdvanced({
          heartbeatIntervalSec: serverData?.heartbeatIntervalSec ?? 5,
          agoraTokenExpireSec: serverData?.agoraTokenExpireSec ?? 3600,
        });
      })
      .finally(() => setLoading(false));
  }, [space.platform, space.externalId]);

  const saveAdvanced = async () => {
    setSavingAdvanced(true);
    setAdvancedError('');
    try {
      await api.updateSuperSpace(space.platform, space.externalId, {
        heartbeatIntervalSec: Number(advanced.heartbeatIntervalSec),
        agoraTokenExpireSec: Number(advanced.agoraTokenExpireSec),
      });
      setAdvancedSaved(true);
      setTimeout(() => setAdvancedSaved(false), 2000);
    } catch (e: any) {
      setAdvancedError(e.message || '保存失败');
    } finally {
      setSavingAdvanced(false);
    }
  };

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
              <p>平台: <span className="uppercase">{server.platform}</span></p>
              <p>平台空间ID: <span className="font-mono">{server.externalId}</span></p>
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
              href={spaceAdminHref(space.platform, space.externalId)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg text-sm text-center bg-white/5 text-muted hover:text-white hover:bg-white/10 transition-colors"
            >
              打开管理面板
            </a>
            <button
              type="button"
              disabled={deleting}
              onClick={async () => {
                const confirmed = window.confirm(
                  `确定删除服务器“${server.guildName || server.serverId}”吗？\n\n服务器配置、绑定信息、事件和会话记录都会被删除。再次注册后必须重新绑定。`,
                );
                if (!confirmed) return;
                setDeleting(true);
                try {
                  await api.deleteSuperSpace(space.platform, space.externalId);
                  onBack();
                } catch (e: any) {
                  alert(e.message || '删除失败');
                  setDeleting(false);
                }
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-center bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? '删除中...' : '删除服务器'}
            </button>
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

        {/* 超管专属参数 */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <h3 className="text-sm font-semibold text-white">超管参数</h3>
          <p className="text-xs text-muted mt-0.5 mb-3">心跳间隔与声网令牌有效期仅由超级管理员设置，各平台空间的管理员无法修改。</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-muted">
              心跳间隔（秒）
              <input
                type="number"
                min={2}
                max={60}
                value={advanced.heartbeatIntervalSec}
                onChange={(e) => setAdvanced((c) => ({ ...c, heartbeatIntervalSec: Number(e.target.value) }))}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand/50"
              />
            </label>
            <label className="text-xs text-muted">
              声网令牌有效期（秒）
              <input
                type="number"
                min={60}
                max={86400}
                value={advanced.agoraTokenExpireSec}
                onChange={(e) => setAdvanced((c) => ({ ...c, agoraTokenExpireSec: Number(e.target.value) }))}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand/50"
              />
            </label>
          </div>
          {advancedError && <p className="text-xs text-red-300 mt-2">{advancedError}</p>}
          <button
            type="button"
            onClick={saveAdvanced}
            disabled={savingAdvanced}
            className="mt-3 btn-brand px-4 py-2 rounded-lg text-sm disabled:opacity-40"
          >
            {savingAdvanced ? '保存中...' : advancedSaved ? '已保存' : '保存超管参数'}
          </button>
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
