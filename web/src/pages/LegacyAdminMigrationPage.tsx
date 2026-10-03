import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, MonitorUp } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function LegacyAdminMigrationPage() {
  const { serverId = '' } = useParams<{ serverId: string }>();
  const location = useLocation();
  const [sunsetAt, setSunsetAt] = useState<number | null>(null);
  const validId = /^\d+$/.test(serverId);
  const target = `/kook/${encodeURIComponent(serverId)}${location.search}${location.hash}`;

  useEffect(() => {
    if (!validId) return;
    api.getAdminMigration()
      .then(({ legacyAdminSunsetAt }) => {
        setSunsetAt(legacyAdminSunsetAt);
        if (legacyAdminSunsetAt > 0 && Date.now() >= legacyAdminSunsetAt) {
          window.location.replace(target);
        }
      })
      .catch(() => setSunsetAt(0));
  }, [target, validId]);

  if (!validId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass rounded-2xl p-8 max-w-sm text-center">
          <h1 className="text-xl font-bold">地址不存在</h1>
          <p className="text-sm text-muted mt-2">请检查访问地址是否正确。</p>
        </div>
      </div>
    );
  }

  if (sunsetAt === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-brand animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-strong rounded-3xl border border-white/15 p-8 sm:p-10 max-w-xl text-center shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-brand flex items-center justify-center mx-auto mb-5"><MonitorUp size={32} strokeWidth={1.7} /></div>
        <h1 className="text-2xl font-bold">KOOK 管理后台地址已迁移</h1>
        <p className="text-sm text-muted leading-relaxed mt-4">
          因系统扩展多平台支持，您的 KOOK 服务器管理后台已迁移至新的平台专属地址。
          原管理密码、服务器配置和历史数据均不受影响。
        </p>
        {sunsetAt > 0 && (
          <p className="text-xs text-dim mt-3">
            当前旧入口将在 {new Date(sunsetAt).toLocaleDateString()} 后停止使用。
          </p>
        )}
        <a
          href={target}
          className="btn-brand mt-7 w-full rounded-xl py-3 px-5 inline-flex items-center justify-center gap-2 text-sm font-medium"
        >
          前往新的 KOOK 管理后台
          <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}
