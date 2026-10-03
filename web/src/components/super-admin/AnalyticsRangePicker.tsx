import type { AnalyticsRange, AnalyticsRangeQuery } from '../../types/analytics';
import { cn } from '../../lib/utils';

const RANGE_OPTIONS: Array<{ value: AnalyticsRange; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'month', label: '自然月' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自定义' },
];

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000;

function toHongKongInput(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp + HONG_KONG_OFFSET_MS).toISOString().slice(0, 16);
}

function fromHongKongInput(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value}:00+08:00`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function AnalyticsRangePicker({
  value,
  onChange,
  compact = false,
}: {
  value: AnalyticsRangeQuery;
  onChange: (next: AnalyticsRangeQuery) => void;
  compact?: boolean;
}) {
  const selectRange = (range: AnalyticsRange) => {
    if (range === 'custom') {
      const to = value.to || Date.now();
      const from = value.from || to - 24 * 60 * 60 * 1000;
      onChange({ range, from, to });
      return;
    }
    onChange({ range });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => selectRange(option.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              value.range === option.value
                ? 'bg-brand/20 text-brand-light ring-1 ring-brand/30'
                : 'bg-white/5 text-muted hover:bg-white/10 hover:text-white',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {value.range === 'custom' && (
        <div className={cn('flex flex-wrap items-center gap-2', compact && 'text-xs')}>
          <input
            type="datetime-local"
            value={toHongKongInput(value.from)}
            onChange={(event) => onChange({
              ...value,
              from: fromHongKongInput(event.target.value),
            })}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:border-brand/50"
          />
          <span className="text-dim">至</span>
          <input
            type="datetime-local"
            value={toHongKongInput(value.to)}
            onChange={(event) => onChange({
              ...value,
              to: fromHongKongInput(event.target.value),
            })}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:border-brand/50"
          />
          <span className="text-[11px] text-dim">香港时间 UTC+8</span>
        </div>
      )}
    </div>
  );
}
