import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  Gauge,
  Link2,
  Monitor,
  Radio,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type {
  AnalyticsOverview,
  AnalyticsRangeQuery,
  AnalyticsRealtime,
  AnalyticsRecordType,
} from '../../types/analytics';
import { AnalyticsRangePicker } from './AnalyticsRangePicker';
import { PlatformBadge, PLATFORM_NAMES } from './PlatformBadge';
import { TrendChart } from './TrendChart';

export interface DashboardRecordTarget extends AnalyticsRangeQuery {
  type: AnalyticsRecordType;
  status?: string;
  platform?: string;
}

const EMPTY_REALTIME: AnalyticsRealtime = {
  collectedAt: 0,
  servers: { botPresent: 0, bound: 0, agoraConfigured: 0, ready: 0, removed: 0 },
  sharing: { ongoing: 0, pending: 0, shareConnections: 0, viewerConnections: 0, adminSessions: 0 },
  coverage: { memberCount: 0, capturedAt: null, isStale: true, serversTotal: 0, serversSucceeded: 0 },
};

const EMPTY_OVERVIEW: AnalyticsOverview = {
  range: { from: null, to: 0, bucket: '' },
  summary: {
    successfulShares: 0,
    unstartedShares: 0,
    startSuccessRate: 0,
    abnormalEnds: 0,
    shareDurationMs: 0,
    viewerJoins: 0,
    viewerDurationMs: 0,
    standardMinutes: 0,
  },
  series: [],
  coverageSeries: [],
  endReasons: [],
  startFailureReasons: [],
};

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0);
}

function formatDuration(value: number): string {
  if (!value) return '0 分钟';
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${formatCount(minutes)} 分钟`;
  const hours = minutes / 60;
  return `${hours >= 100 ? Math.round(hours) : hours.toFixed(1)} 小时`;
}

function formatPercent(value: number): string {
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.max(0, normalized).toFixed(1)}%`;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    stopped: '共享者停止', stopped_timeout: '停止后恢复超时',
    heartbeat_timeout: '共享端心跳超时', no_viewer_timeout: '长时间无人观看',
    max_age: '达到最长时限', not_started_timeout: '等待启动超时',
    server_deleted: '服务器删除', unknown: '未知原因',
    capture_permission_denied: '未授权屏幕采集', insecure_context: '非安全访问环境',
    screen_audio_unavailable: '未提供共享音频', rtc_sdk_unavailable: '实时通信组件不可用',
    session_ended: '链接已失效', network_error: '网络异常',
    publish_failed: '发布失败', start_rejected: '启动请求被拒绝',
  };
  return labels[reason] || reason.replace(/_/g, ' ');
}

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
  tone = 'brand',
  onClick,
}: {
  label: string;
  value: string;
  note?: string;
  icon: typeof Activity;
  tone?: 'brand' | 'green' | 'blue' | 'yellow' | 'red' | 'purple';
  onClick?: () => void;
}) {
  const tones = {
    brand: 'bg-brand/15 text-brand-light',
    green: 'bg-green-500/15 text-green-300',
    blue: 'bg-blue-500/15 text-blue-300',
    yellow: 'bg-yellow-500/15 text-yellow-300',
    red: 'bg-red-500/15 text-red-300',
    purple: 'bg-purple-500/15 text-purple-300',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'glass min-w-0 rounded-2xl p-4 text-left transition-all',
        onClick && 'cursor-pointer hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-lg',
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted">{label}</p>
        <span className={cn('rounded-lg p-2', tones[tone])}><Icon className="h-4 w-4" /></span>
      </div>
      <p className="truncate text-2xl font-bold text-white">{value}</p>
      {note && <p className="mt-1 truncate text-[11px] text-dim">{note}</p>}
    </button>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="font-semibold text-white">{title}</h2>
      <p className="mt-0.5 text-xs text-dim">{subtitle}</p>
    </div>
  );
}

export default function DashboardPanel({
  onOpenRecords,
}: {
  onOpenRecords: (target: DashboardRecordTarget) => void;
}) {
  const [coveragePlatform, setCoveragePlatform] = useState('kook');
  const [range, setRange] = useState<AnalyticsRangeQuery>({ range: '24h' });
  const [realtime, setRealtime] = useState<AnalyticsRealtime>(EMPTY_REALTIME);
  const [overview, setOverview] = useState<AnalyticsOverview>(EMPTY_OVERVIEW);
  const [realtimeError, setRealtimeError] = useState('');
  const [overviewError, setOverviewError] = useState('');
  const [overviewLoading, setOverviewLoading] = useState(true);

  const loadRealtime = useCallback(async () => {
    try {
      const data = await api.getAnalyticsRealtime();
      setRealtime({
        ...EMPTY_REALTIME,
        ...data,
        servers: { ...EMPTY_REALTIME.servers, ...(data?.servers || {}) },
        sharing: { ...EMPTY_REALTIME.sharing, ...(data?.sharing || {}) },
        coverage: { ...EMPTY_REALTIME.coverage, ...(data?.coverage || {}) },
      });
      setRealtimeError('');
    } catch (error: any) {
      setRealtimeError(error?.message || '实时数据加载失败');
    }
  }, []);

  useEffect(() => {
    void loadRealtime();
    const timer = window.setInterval(() => void loadRealtime(), 5_000);
    return () => window.clearInterval(timer);
  }, [loadRealtime]);

  useEffect(() => {
    let cancelled = false;
    setOverviewLoading(true);
    api.getAnalyticsOverview(range)
      .then((data) => {
        if (cancelled) return;
        setOverview({
          ...EMPTY_OVERVIEW,
          ...data,
          range: { ...EMPTY_OVERVIEW.range, ...(data?.range || {}) },
          summary: { ...EMPTY_OVERVIEW.summary, ...(data?.summary || {}) },
          series: Array.isArray(data?.series) ? data.series : [],
          coverageSeries: Array.isArray(data?.coverageSeries) ? data.coverageSeries : [],
          endReasons: Array.isArray(data?.endReasons) ? data.endReasons : [],
          startFailureReasons: Array.isArray(data?.startFailureReasons) ? data.startFailureReasons : [],
        });
        setOverviewError('');
      })
      .catch((error: any) => {
        if (!cancelled) setOverviewError(error?.message || '区间统计加载失败');
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [range]);

  const openRecords = (type: AnalyticsRecordType, status?: string) => {
    onOpenRecords({ ...range, type, status });
  };

  const collectedText = realtime.collectedAt
    ? new Date(realtime.collectedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Hong_Kong' })
    : '尚未采集';
  const selectedCoverage = realtime.coverageByPlatform?.[coveragePlatform] || (coveragePlatform === 'kook' ? realtime.coverage : { memberCount: null, capturedAt: null, isStale: true, serversTotal: 0, serversSucceeded: 0 });
  const coverageText = selectedCoverage.capturedAt
    ? new Date(selectedCoverage.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })
    : '暂无快照';

  const shareTrend = useMemo(() => overview.series.map((point) => ({
    timestamp: point.timestamp,
    value: point.successfulShares || 0,
    secondaryValue: point.unstartedShares || 0,
  })), [overview.series]);
  const coverageTrend = useMemo(() => {
    const points = overview.coverageSeriesByPlatform?.[coveragePlatform] || (coveragePlatform === 'kook' ? overview.coverageSeries : []);
    return points.filter(point => point.memberCount !== null).map(point => ({ timestamp: point.timestamp, value: point.memberCount as number }));
  }, [overview.coverageSeries, overview.coverageSeriesByPlatform, coveragePlatform]);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className={cn('h-2 w-2 rounded-full', realtimeError ? 'bg-red-400' : 'bg-green-400 animate-pulse')} />
          实时数据 · {collectedText}
        </div>
        <button
          type="button"
          onClick={() => void loadRealtime()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs text-muted transition-colors hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      {!!realtime.recoveringRooms && <p role="status" className="text-sm text-amber-200">服务重启后正在恢复 {realtime.recoveringRooms} 个房间，在线人数暂未确认，恢复完成后自动更新。</p>}
      {realtimeError && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          {realtimeError}，系统会继续自动重试。
        </div>
      )}

      <section className="space-y-3">
        <SectionTitle title="平台空间实时状态" subtitle="KOOK、黑盒语音、QQ 群与自建面板" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(PLATFORM_NAMES).map(([platform]) => {
            const counts = realtime.platformSpaces?.[platform];
            return <button key={platform} type="button" onClick={() => onOpenRecords({ ...range, type: 'server', platform })} className="glass rounded-xl p-4 text-left hover:bg-white/5">
              <PlatformBadge platform={platform} />
              <p className="mt-2 text-sm text-white">{counts?.total ?? '—'} 个{platform === 'panel' ? '面板' : '平台空间'}</p>
              <p className="mt-1 text-xs text-muted">{platform === 'panel' ? `已启用 ${counts?.active ?? '—'} · 已停用 ${counts ? counts.total - counts.active : '—'}` : `当前在场 ${counts?.active ?? '—'} · 已移除 ${counts?.removed ?? '—'}`} · 点击查看</p>
            </button>;
          })}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard label="机器人当前仍在" value={formatCount(realtime.servers.botPresent)} icon={Server} onClick={() => openRecords('server', 'bot_present')} />
          <MetricCard label="已完成后台绑定" value={formatCount(realtime.servers.bound)} icon={Link2} tone="blue" onClick={() => openRecords('server', 'bound')} />
          <MetricCard label="已配置声网凭证" value={formatCount(realtime.servers.agoraConfigured)} icon={Settings} tone="purple" onClick={() => openRecords('server', 'agora_configured')} />
          <MetricCard label="已具备共享条件" value={formatCount(realtime.servers.ready)} icon={ShieldCheck} tone="green" onClick={() => openRecords('server', 'ready')} />
          <MetricCard label="已移除机器人" value={formatCount(realtime.servers.removed)} icon={Ban} tone="red" onClick={() => openRecords('server', 'removed')} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle title="屏幕分享实时状态" subtitle="在线数按匿名浏览器会话去重，不记录个人身份" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="正在进行的共享" value={formatCount(realtime.sharing.ongoing)} note={`${formatCount(realtime.sharing.pending)} 个等待开始`} icon={Radio} tone="green" onClick={() => openRecords('share', 'ongoing')} />
          <MetricCard label="共享页当前在线" value={realtime.recoveringRooms ? '恢复中' : formatCount(realtime.sharing.shareConnections)} note={realtime.recoveringRooms ? `已重连 ${realtime.sharing.shareConnections}` : undefined} icon={Monitor} onClick={() => openRecords('share')} />
          <MetricCard label="当前观众" value={realtime.recoveringRooms ? '恢复中' : formatCount(realtime.sharing.viewerConnections)} note={realtime.recoveringRooms ? `已重连 ${realtime.sharing.viewerConnections}` : undefined} icon={Eye} tone="blue" onClick={() => openRecords('share')} />
          <MetricCard label="用户管理后台在线" value={formatCount(realtime.sharing.adminSessions)} icon={Users} tone="purple" />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle title="区间使用汇总" subtitle="所有时长均为系统侧汇总，不展示个人访问明细" />
          <AnalyticsRangePicker value={range} onChange={setRange} />
        </div>
        {overviewError && (
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-xs text-yellow-200">
            {overviewError}
          </div>
        )}
        <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', overviewLoading && 'opacity-60')}>
          <MetricCard label="成功共享" value={formatCount(overview.summary.successfulShares)} icon={CheckCircle2} tone="green" onClick={() => openRecords('share', 'successful')} />
          <MetricCard label="未启动" value={formatCount(overview.summary.unstartedShares)} icon={Clock} tone="yellow" onClick={() => openRecords('share', 'unstarted')} />
          <MetricCard label="启动成功率" value={formatPercent(overview.summary.startSuccessRate)} icon={TrendingUp} tone="blue" />
          <MetricCard label="异常结束" value={formatCount(overview.summary.abnormalEnds)} icon={AlertTriangle} tone="red" onClick={() => openRecords('share', 'abnormal')} />
          <MetricCard label="实际共享时长" value={formatDuration(overview.summary.shareDurationMs)} icon={Activity} />
          <MetricCard label="累计观看人次" value={formatCount(overview.summary.viewerJoins)} icon={Users} tone="blue" />
          <MetricCard label="估算观众总时长" value={formatDuration(overview.summary.viewerDurationMs)} icon={Eye} tone="purple" />
          <MetricCard label="估算声网标准分钟" value={formatCount(overview.summary.standardMinutes)} icon={Gauge} tone="brand" />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <SectionTitle title="共享趋势" subtitle={`KOOK + 黑盒语音 + QQ 群；${range.range === '24h' ? '每小时' : '每日'}汇总，成功按首次开始时间、未启动按创建时间归属`} />
            <Activity className="h-4 w-4 text-brand-light" />
          </div>
          <TrendChart points={shareTrend} primaryLabel="成功共享" secondaryLabel="未启动" unit="次" />
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <SectionTitle title="覆盖成员数趋势" subtitle={`${PLATFORM_NAMES[coveragePlatform]}；${range.range === '24h' ? '每小时' : '每日'}取最后一次快照，成员数跨服务器未去重`} />
            <Users className="h-4 w-4 text-blue-300" />
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(PLATFORM_NAMES).map(([platform, label]) => <button key={platform} type="button" aria-pressed={coveragePlatform === platform} onClick={() => setCoveragePlatform(platform)} className={cn('rounded-full px-3 py-1.5 text-xs border', coveragePlatform === platform ? 'border-brand/40 bg-brand/15 text-brand-light' : 'border-white/10 text-muted hover:text-white')}>{label}</button>)}
          </div>
          <TrendChart points={coverageTrend} primaryLabel="覆盖成员数" primaryColor="#60A5FA" unit="人（未去重）" />
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 text-xs">
            <div>
              <p className="text-dim">{PLATFORM_NAMES[coveragePlatform]} 覆盖成员数</p>
              <p className="mt-1 text-lg font-semibold text-white">{selectedCoverage.memberCount === null ? '尚未获取' : formatCount(selectedCoverage.memberCount)}</p>
            </div>
            <div>
              <p className="text-dim">快照新鲜度</p>
              <p className={cn('mt-1 font-medium', selectedCoverage.isStale ? 'text-yellow-300' : 'text-green-300')}>
                {selectedCoverage.serversTotal === 0 ? '暂无在场空间' : selectedCoverage.isStale ? '采集不完整或已过期' : '数据新鲜'}
              </p>
              <p className="mt-1 text-[11px] text-dim">{coverageText}</p>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-dim">
            成功采集 {formatCount(selectedCoverage.serversSucceeded)} / {formatCount(selectedCoverage.serversTotal)} 个在场空间。未知成员数不按零计算，历史趋势从接入采集后开始积累。
          </p>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {[
          { title: '启动失败原因汇总', subtitle: '记录启动前最后一次匿名失败原因', items: overview.startFailureReasons },
          { title: '结束原因汇总', subtitle: '用于排查共享中断、超时及未正常结束情况', items: overview.endReasons },
        ].map((group) => (
          <div key={group.title} className="glass rounded-2xl p-5">
            <SectionTitle title={group.title} subtitle={group.subtitle} />
            {group.items.length === 0 ? (
              <p className="py-8 text-center text-sm text-dim">当前时间段暂无记录</p>
            ) : (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {group.items.map((item) => (
                  <div key={item.reason} className="rounded-xl bg-white/5 px-4 py-3">
                    <p className="text-xs text-muted">{reasonLabel(item.reason)}</p>
                    <p className="mt-1 text-xl font-semibold text-white">{formatCount(item.count)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
