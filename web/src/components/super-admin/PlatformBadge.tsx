export const PLATFORM_NAMES: Record<string, string> = { kook: 'KOOK', heychat: '黑盒语音', qq: 'QQ 群', panel: '自建面板' };
const COLORS: Record<string, string> = { kook: 'bg-purple-500/15 text-purple-300 border-purple-400/20', heychat: 'bg-amber-500/15 text-amber-300 border-amber-400/20', qq: 'bg-blue-500/15 text-blue-300 border-blue-400/20' };

export function PlatformBadge({ platform }: { platform?: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${COLORS[platform || ''] || 'bg-white/5 text-muted border-white/10'}`}>
    <span className="h-1.5 w-1.5 rounded-full bg-current" />{PLATFORM_NAMES[platform || ''] || platform || '未知平台'}
  </span>;
}
