import { useState } from 'react';

export interface TrendPoint {
  timestamp: number;
  value: number;
  secondaryValue?: number;
}
const WIDTH = 720;
const HEIGHT = 230;
const LEFT = 72;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 36;
const count = (value: number) => value.toLocaleString('zh-CN');
const time = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(timestamp);

export function TrendChart({ points, primaryLabel, secondaryLabel,
  primaryColor = '#FF8C42', secondaryColor = '#60A5FA', unit = '次',
}: { points: TrendPoint[]; primaryLabel: string; secondaryLabel?: string;
  primaryColor?: string; secondaryColor?: string; unit?: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!points.length) return <div className="flex h-52 items-center justify-center text-sm text-dim">当前时间段暂无趋势数据</div>;
  const maximum = Math.max(1, ...points.map(p => Math.max(p.value, p.secondaryValue || 0)));
  const step = Math.max(1, Math.ceil(maximum / 4));
  const max = step * 4;
  const first = points[0].timestamp;
  const last = points[points.length - 1].timestamp;
  const x = (timestamp: number) => first === last ? (LEFT + WIDTH - RIGHT) / 2
    : LEFT + (timestamp - first) / (last - first) * (WIDTH - LEFT - RIGHT);
  const y = (value: number) => HEIGHT - BOTTOM - value / max * (HEIGHT - TOP - BOTTOM);
  const line = (secondary = false) => points.map(p => `${x(p.timestamp)},${y(secondary ? p.secondaryValue || 0 : p.value)}`).join(' ');
  const active = points[Math.min(selected ?? points.length - 1, points.length - 1)];
  return <div>
    <div className="mb-2 flex flex-wrap gap-4 text-xs">
      <span style={{ color: primaryColor }}>● {primaryLabel}</span>
      {secondaryLabel && <span style={{ color: secondaryColor }}>┄ {secondaryLabel}</span>}
      <span className="text-dim">单位：{unit} · 北京时间</span>
    </div>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`${primaryLabel}时间趋势；下方可查看具体数值`}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}>
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(i * step)} y2={y(i * step)} stroke="rgba(255,255,255,.12)" />
        <text x={LEFT - 8} y={y(i * step) + 4} textAnchor="end" fill="#9ca3af" fontSize="12">{count(i * step)}</text>
      </g>)}
      <polyline points={line()} fill="none" stroke={primaryColor} strokeWidth="2.5" />
      {secondaryLabel && <polyline points={line(true)} fill="none" stroke={secondaryColor} strokeWidth="2" strokeDasharray="6 4" />}
      {points.map((p, i) => <g key={p.timestamp}>
        <circle cx={x(p.timestamp)} cy={y(p.value)} r={points.length < 80 ? 3 : 1.5} fill={primaryColor} />
        {secondaryLabel && <circle cx={x(p.timestamp)} cy={y(p.secondaryValue || 0)} r={points.length < 80 ? 3 : 1.5} fill={secondaryColor} />}
        <rect x={x(p.timestamp) - Math.max(3, (WIDTH - LEFT - RIGHT) / points.length / 2)} y={TOP}
          width={Math.max(6, (WIDTH - LEFT - RIGHT) / points.length)} height={HEIGHT - TOP - BOTTOM}
          fill="transparent" onMouseEnter={() => setSelected(i)} onClick={() => setSelected(i)}>
          <title>{time(p.timestamp)}：{primaryLabel} {count(p.value)}{secondaryLabel ? `，${secondaryLabel} ${count(p.secondaryValue || 0)}` : ''}</title>
        </rect>
      </g>)}
      <line x1={x(active.timestamp)} x2={x(active.timestamp)} y1={TOP} y2={HEIGHT - BOTTOM} stroke="#fff" opacity=".3" strokeDasharray="3 3" />
      <text x={LEFT} y={HEIGHT - 10} fill="#9ca3af" fontSize="12">{time(first)}</text>
      {first !== last && <text x={WIDTH - RIGHT} y={HEIGHT - 10} textAnchor="end" fill="#9ca3af" fontSize="12">{time(last)}</text>}
    </svg>
    <div className="rounded-lg bg-white/5 px-3 py-2 text-xs text-muted" aria-live="polite">
      {time(active.timestamp)} · {primaryLabel} <strong className="text-white">{count(active.value)}</strong>
      {secondaryLabel && <> · {secondaryLabel} <strong className="text-white">{count(active.secondaryValue || 0)}</strong></>}
    </div>
    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">查看数据明细（{points.length} 个时间点）</summary>
      <div className="mt-2 max-h-52 overflow-auto"><table className="w-full text-right"><thead><tr>
        <th className="p-2 text-left">时间（北京时间）</th><th>{primaryLabel}</th>{secondaryLabel && <th>{secondaryLabel}</th>}
      </tr></thead><tbody>{points.map(p => <tr key={p.timestamp} className="border-t border-white/5">
        <td className="p-2 text-left">{time(p.timestamp)}</td><td>{count(p.value)}</td>{secondaryLabel && <td>{count(p.secondaryValue || 0)}</td>}
      </tr>)}</tbody></table></div>
    </details>
  </div>;
}
