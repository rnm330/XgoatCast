import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Filter, Monitor, RefreshCw, Server, Users } from 'lucide-react';
import { PlatformBadge, PLATFORM_NAMES } from './PlatformBadge';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type {
  AnalyticsOverview,
  AnalyticsRangeQuery,
  AnalyticsRecordType,
  ClientStatsItem,
  ServerAnalyticsRecord,
  ServerStateAnalyticsRecord,
  ShareAnalyticsRecord,
} from '../../types/analytics';
import { AnalyticsRangePicker } from './AnalyticsRangePicker';
import type { DashboardRecordTarget } from './DashboardPanel';

const PAGE_SIZE = 50;

const SHARE_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'successful', label: '成功共享' },
  { value: 'unstarted', label: '未启动' },
  { value: 'ongoing', label: '正在进行' },
  { value: 'pending', label: '等待开始' },
  { value: 'abnormal', label: '异常结束' },
];

const SERVER_STATUS_OPTIONS = [
  { value: '', label: '全部变更' },
  { value: 'bot_joined', label: '机器人加入' },
  { value: 'bot_removed', label: '机器人移除' },
  { value: 'bound', label: '后台绑定' },
  { value: 'agora_configured', label: '声网配置' },
  { value: 'ready', label: '可用状态变化' },
];

const SERVER_STATE_OPTIONS = [
  { value: '', label: '全部当前服务器' },
  { value: 'bot_present', label: '机器人当前仍在' },
  { value: 'bound', label: '已绑定后台' },
  { value: 'agora_configured', label: '已配置声网' },
  { value: 'ready', label: '已具备共享条件' },
  { value: 'removed', label: '当前已被移出' },
];

function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatDuration(value: number | null | undefined): string {
  if (!value) return '-';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

function formatDate(value: number): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' });
}

function friendlyCode(code: string | null | undefined): string {
  const labels: Record<string, string> = {
    capture_permission_denied: '未授权屏幕采集',
    insecure_context: '非安全访问环境',
    screen_audio_unavailable: '未提供共享音频',
    rtc_sdk_unavailable: '实时通信组件不可用',
    session_ended: '会话已失效',
    network_error: '网络异常',
    publish_failed: '发布失败',
    start_rejected: '启动请求被拒绝',
    idle_timeout: '等待启动超时',
    no_viewer_timeout: '长时间无人观看',
    heartbeat: '共享端失联',
    max_age: '达到最长时限',
    stopped: '共享者停止',
    stopped_timeout: '共享者停止后未恢复',
    heartbeat_timeout: '共享端失联超时',
    not_started_timeout: '等待启动超时',
    server_deleted: '服务器已删除',
  };
  if (!code) return '-';
  return labels[code] || code.replace(/_/g, ' ');
}

function shareStatus(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: '进行中', className: 'bg-green-500/15 text-green-300' },
    ongoing: { label: '进行中', className: 'bg-green-500/15 text-green-300' },
    pending: { label: '等待开始', className: 'bg-yellow-500/15 text-yellow-300' },
    grace: { label: '等待恢复', className: 'bg-orange-500/15 text-orange-300' },
    ended: { label: '已结束', className: 'bg-white/10 text-muted' },
    successful: { label: '成功共享', className: 'bg-green-500/15 text-green-300' },
    unstarted: { label: '未启动', className: 'bg-yellow-500/15 text-yellow-300' },
    abnormal: { label: '异常结束', className: 'bg-red-500/15 text-red-300' },
  };
  return map[status] || { label: status || '未知', className: 'bg-white/10 text-muted' };
}

function eventLabel(eventType: string | null | undefined): string {
  if (!eventType) return '未知变更';
  const labels: Record<string, string> = {
    bot_joined: '机器人加入',
    bot_kicked: '机器人移除',
    bot_removed: '机器人移除',
    server_bound: '管理后台绑定',
    bound: '管理后台绑定',
    agora_configured: '声网配置完成',
    agora_unconfigured: '声网配置清除',
    server_ready: '服务器可用',
    server_deleted: '服务器删除',
  };
  return labels[eventType] || eventType.replace(/_/g, ' ');
}

function DistributionList({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: typeof Monitor;
  items: Array<{ label: string; value: number }>;
}) {
  const topItems = items.slice(0, 6);
  const max = Math.max(1, ...topItems.map((item) => item.value));
  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand-light" />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      {topItems.length === 0 ? (
        <p className="py-5 text-center text-xs text-dim">暂无匿名汇总数据</p>
      ) : (
        <div className="space-y-3">
          {topItems.map((item) => (
            <div key={item.label}>
              <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-muted">{item.label}</span>
                <span className="font-medium text-white">{formatCount(item.value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-dark to-brand"
                  style={{ width: `${Math.max(3, (item.value / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function aggregateStats(items: ClientStatsItem[], key: (item: ClientStatsItem) => string) {
  const values = new Map<string, number>();
  for (const item of items) {
    const label = key(item) || 'Unknown';
    values.set(label, (values.get(label) || 0) + (Number(item.count) || 0));
  }
  return [...values.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function ShareRecordsTable({ items }: { items: ShareAnalyticsRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs text-muted">
            <th className="px-4 py-3">服务器</th>
            <th className="px-4 py-3">状态</th>
            <th className="px-4 py-3">创建 / 开始 / 结束</th>
            <th className="px-4 py-3">共享时长</th>
            <th className="px-4 py-3">观看汇总</th>
            <th className="px-4 py-3">画质 / 模式</th>
            <th className="px-4 py-3">结束结果</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={7} className="px-4 py-12 text-center text-muted">当前筛选条件下暂无共享记录</td></tr>
          ) : items.map((item) => {
            const status = shareStatus(item.status);
            return (
              <tr key={item.id} className="border-b border-white/5 align-top hover:bg-white/[0.025]">
                <td className="px-4 py-3">
                  <p className="max-w-[220px] truncate font-medium text-white">{item.serverName || '未命名服务器'}</p><PlatformBadge platform={item.platform} />
                  <p className="mt-1 font-mono text-[11px] text-dim">{item.serverSnowflakeId || '-'}</p>
                </td>
                <td className="px-4 py-3"><span className={cn('rounded-md px-2 py-1 text-xs', status.className)}>{status.label}</span></td>
                <td className="px-4 py-3 text-xs text-muted">
                  <p>创建 {formatDate(item.createdAt)}</p>
                  <p className="mt-1 text-dim">开始 {item.startedAt ? formatDate(item.startedAt) : '-'}</p>
                  <p className="mt-1 text-dim">结束 {item.endedAt ? formatDate(item.endedAt) : '-'}</p>
                </td>
                <td className="px-4 py-3 text-xs">
                  <p>{formatDuration(item.durationMs)}</p>
                  <p className="mt-1 text-dim">{formatCount(item.standardMinutes)} 标准分钟</p>
                </td>
                <td className="px-4 py-3 text-xs">
                  <p>{formatCount(item.viewerJoins)} 人次 · 峰值 {formatCount(item.peakViewers)}</p>
                  <p className="mt-1 text-dim">估算观众时长 {formatDuration(item.viewerDurationMs)}</p>
                </td>
                <td className="px-4 py-3 text-xs">
                  <p>{item.quality || '-'}</p>
                  <p className="mt-1 text-dim">{item.lowLatency ? '低延迟' : '极速直播'}</p>
                </td>
                <td className="px-4 py-3 text-xs text-muted">{friendlyCode(item.startFailureReason || item.endReason)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ServerRecordsTable({ items }: { items: ServerAnalyticsRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs text-muted">
            <th className="px-4 py-3">服务器</th>
            <th className="px-4 py-3">变更类型</th>
            <th className="px-4 py-3">发生时间</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-12 text-center text-muted">当前筛选条件下暂无服务器变更记录</td></tr>
          ) : items.map((item) => (
            <tr key={item.id} className="border-b border-white/5 hover:bg-white/[0.025]">
              <td className="px-4 py-3">
                <p className="font-medium text-white">{item.serverName || '未命名服务器'}</p><PlatformBadge platform={item.platform} />
                <p className="mt-1 font-mono text-[11px] text-dim">{item.serverSnowflakeId || '-'}</p>
              </td>
              <td className="px-4 py-3 text-muted"><p>{eventLabel(item.eventType)}</p>{item.reason && <p className="mt-1 text-[11px] text-dim">{friendlyCode(item.reason)}</p>}</td>
              <td className="px-4 py-3 text-xs text-muted">{formatDate(item.occurredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StateBadge({ active, children }: { active: boolean; children: string }) {
  return <span className={cn('rounded-md px-2 py-1 text-[11px]', active ? 'bg-green-500/15 text-green-300' : 'bg-white/5 text-dim')}>{children}</span>;
}

function ServerStateTable({ items }: { items: ServerStateAnalyticsRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[780px] text-sm">
        <thead><tr className="border-b border-white/10 text-left text-xs text-muted">
          <th className="px-4 py-3">服务器</th><th className="px-4 py-3">当前状态</th><th className="px-4 py-3">最近更新</th>
        </tr></thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-12 text-center text-muted">当前筛选条件下暂无服务器</td></tr>
          ) : items.map((item) => (
            <tr key={item.id} className="border-b border-white/5 hover:bg-white/[0.025]">
              <td className="px-4 py-3"><p className="font-medium text-white">{item.serverName || '未命名服务器'}</p><PlatformBadge platform={item.platform} /><p className="mt-1 font-mono text-[11px] text-dim">{item.serverSnowflakeId}</p></td>
              <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5">
                <StateBadge active={item.botPresent}>{item.botPresent ? '机器人仍在' : '机器人已移出'}</StateBadge>
                <StateBadge active={item.bound}>后台已绑定</StateBadge>
                <StateBadge active={item.agoraConfigured}>声网已配置</StateBadge>
                <StateBadge active={item.ready}>可发起共享</StateBadge>
              </div></td>
              <td className="px-4 py-3 text-xs text-muted">{formatDate(item.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RecordsPanel({ initialTarget }: { initialTarget?: DashboardRecordTarget | null }) {
  const [type, setType] = useState<AnalyticsRecordType>(initialTarget?.type || 'share');
  const [range, setRange] = useState<AnalyticsRangeQuery>({ range: initialTarget?.range || '24h', from: initialTarget?.from, to: initialTarget?.to });
  const [status, setStatus] = useState(initialTarget?.status || '');
  const [platform, setPlatform] = useState(initialTarget?.platform || '');
  const [serverFilter, setServerFilter] = useState('');
  const [appliedServer, setAppliedServer] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Array<ShareAnalyticsRecord | ServerAnalyticsRecord | ServerStateAnalyticsRecord>>([]);
  const [total, setTotal] = useState(0);
  const [clientStats, setClientStats] = useState<ClientStatsItem[]>([]);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (range.range === 'custom' && (!range.from || !range.to || range.from >= range.to)) {
      setLoading(false);
      setError('请选择有效的自定义开始和结束时间');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      api.getAnalyticsRecords({ ...range, type, platform: platform || undefined, page, pageSize: PAGE_SIZE, status: status || undefined, server: appliedServer || undefined }),
      api.getAnalyticsClientStats(range),
      type === 'share' ? api.getAnalyticsOverview(range) : Promise.resolve(null),
    ])
      .then(([records, stats, summary]) => {
        if (cancelled) return;
        setItems(Array.isArray(records?.items) ? records.items : []);
        setTotal(Number(records?.total) || 0);
        setClientStats(Array.isArray(stats?.items) ? stats.items : []);
        setOverview(summary);
      })
      .catch((requestError: any) => { if (!cancelled) setError(requestError?.message || '记录加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, range, status, appliedServer, page, platform]);

  const changeType = (next: AnalyticsRecordType) => {
    if (next === type) return;
    // A type change renders synchronously, before the replacement request
    // finishes. Never feed rows from the previous record shape into the new
    // table (server snapshot rows, for example, do not have eventType).
    setItems([]);
    setTotal(0);
    setError('');
    setLoading(true);
    setType(next);
    setStatus('');
    setPage(1);
  };
  const changeRange = (next: AnalyticsRangeQuery) => { setRange(next); setPage(1); };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const statusOptions = type === 'share' ? SHARE_STATUS_OPTIONS : type === 'server' ? SERVER_STATE_OPTIONS : SERVER_STATUS_OPTIONS;
  const hasUnknownStatus = !!status && !statusOptions.some((option) => option.value === status);

  const pageStats = useMemo(() => aggregateStats(clientStats, (item) => item.pageType === 'share' ? '共享页' : item.pageType === 'view' ? '观看页' : '用户管理后台'), [clientStats]);
  const deviceStats = useMemo(() => aggregateStats(clientStats, (item) => ({ desktop: '桌面设备', mobile: '手机', tablet: '平板', unknown: '未知设备' }[item.deviceType] || item.deviceType)), [clientStats]);
  const osStats = useMemo(() => aggregateStats(clientStats, (item) => item.osName || 'Unknown'), [clientStats]);
  const browserStats = useMemo(() => aggregateStats(clientStats, (item) => `${item.browserName || 'Unknown'}${item.browserMajor ? ` ${item.browserMajor}` : ''}`), [clientStats]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl bg-white/5 p-1">
          <button type="button" onClick={() => changeType('share')} className={cn('rounded-lg px-4 py-2 text-sm transition-colors', type === 'share' ? 'bg-brand/20 text-brand-light' : 'text-muted hover:text-white')}>共享记录</button>
          <button type="button" onClick={() => changeType('server')} className={cn('rounded-lg px-4 py-2 text-sm transition-colors', type === 'server' ? 'bg-brand/20 text-brand-light' : 'text-muted hover:text-white')}>当前服务器</button>
          <button type="button" onClick={() => changeType('server-event')} className={cn('rounded-lg px-4 py-2 text-sm transition-colors', type === 'server-event' ? 'bg-brand/20 text-brand-light' : 'text-muted hover:text-white')}>服务器变更</button>
        </div>
        <p className="text-xs text-dim">仅展示服务器与匿名汇总，不展示个人访问明细</p>
      </div>

      <div className="glass rounded-2xl p-4">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-white"><Filter className="h-4 w-4 text-brand-light" />筛选条件</div>
        <div className="space-y-4">
          {type === 'server' ? <p className="text-xs text-muted">当前状态快照不受时间范围限制</p> : <AnalyticsRangePicker value={range} onChange={changeRange} compact />}
          <div className="flex flex-wrap gap-2">
            <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-surface-light px-3 py-2 text-xs text-white outline-none focus:border-brand/50">
              {hasUnknownStatus && <option value={status}>当前看板筛选：{status}</option>}
              {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select aria-label="平台筛选" value={platform} onChange={e => { setPlatform(e.target.value); setPage(1); }} className="rounded-lg bg-surface-dark border border-white/10 px-3 py-2 text-xs text-white">
              <option value="">全部平台</option>{Object.entries(PLATFORM_NAMES).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <input
              value={serverFilter}
              onChange={(event) => setServerFilter(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { setAppliedServer(serverFilter.trim()); setPage(1); } }}
              placeholder="服务器名或雪花 ID"
              className="min-w-[220px] flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none placeholder:text-dim focus:border-brand/50"
            />
            <button type="button" onClick={() => { setAppliedServer(serverFilter.trim()); setPage(1); }} className="rounded-lg bg-brand/15 px-4 py-2 text-xs font-medium text-brand-light hover:bg-brand/25">应用</button>
            {(status || appliedServer || platform) && <button type="button" onClick={() => { setStatus(''); setPlatform(''); setServerFilter(''); setAppliedServer(''); setPage(1); }} className="rounded-lg bg-white/5 px-4 py-2 text-xs text-muted hover:bg-white/10 hover:text-white">清除筛选</button>}
          </div>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-300"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}

      {type === 'share' && overview && !platform && !status && !appliedServer && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="glass rounded-xl p-4"><p className="text-xs text-dim">成功共享</p><p className="mt-1 text-xl font-semibold">{formatCount(overview.summary.successfulShares)}</p></div>
          <div className="glass rounded-xl p-4"><p className="text-xs text-dim">未启动</p><p className="mt-1 text-xl font-semibold">{formatCount(overview.summary.unstartedShares)}</p></div>
          <div className="glass rounded-xl p-4"><p className="text-xs text-dim">观看人次</p><p className="mt-1 text-xl font-semibold">{formatCount(overview.summary.viewerJoins)}</p></div>
          <div className="glass rounded-xl p-4"><p className="text-xs text-dim">估算观众总时长</p><p className="mt-1 text-xl font-semibold">{formatDuration(overview.summary.viewerDurationMs)}</p></div>
        </div>
      )}

      <div className={cn('glass overflow-hidden rounded-2xl', loading && 'opacity-60')}>
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div><p className="text-sm font-medium text-white">{type === 'share' ? '共享记录' : type === 'server' ? '当前服务器' : '服务器变更记录'}</p><p className="mt-0.5 text-[11px] text-dim">共 {formatCount(total)} 条，每页 {PAGE_SIZE} 条</p></div>
          {loading && <RefreshCw className="h-4 w-4 animate-spin text-brand-light" />}
        </div>
        {type === 'share' ? <ShareRecordsTable items={items as ShareAnalyticsRecord[]} /> : type === 'server' ? <ServerStateTable items={items as ServerStateAnalyticsRecord[]} /> : <ServerRecordsTable items={items as ServerAnalyticsRecord[]} />}
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs">
          <span className="text-dim">第 {page} / {totalPages} 页</span>
          <div className="flex gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2 text-muted hover:bg-white/10 hover:text-white disabled:opacity-30"><ChevronLeft className="h-3.5 w-3.5" />上一页</button>
            <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2 text-muted hover:bg-white/10 hover:text-white disabled:opacity-30">下一页<ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div><h2 className="font-semibold text-white">匿名客户端环境分布</h2><p className="mt-0.5 text-xs text-dim">仅汇总设备类别、操作系统族与浏览器族/主版本，不采集原始 UA、型号或指纹</p></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <DistributionList title="页面" icon={Users} items={pageStats} />
          <DistributionList title="设备类别" icon={Monitor} items={deviceStats} />
          <DistributionList title="操作系统" icon={Server} items={osStats} />
          <DistributionList title="浏览器" icon={Clock} items={browserStats} />
        </div>
      </section>
    </div>
  );
}
