import { useState } from 'react';
import { Github, Monitor, Users, Zap, Settings, Mail, ExternalLink, Gauge, Volume2 } from 'lucide-react';

const GITHUB_URL = 'https://github.com/rnm330/XgoatCast';
const DEVELOPER = 'xgoat小羊';
const EMAIL = 'xgoateam@gmail.com';

const FEATURES = [
  {
    icon: Users,
    title: '免登录观看',
    desc: '频道成员点击卡片即可观看，无需安装、无需注册。',
  },
  {
    icon: Gauge,
    title: '低延迟直播',
    desc: '支持低延迟直播模式，最低可达 200ms，满足不同场景需求。',
  },
  {
    icon: Volume2,
    title: '窗口声音隔离',
    desc: '只共享选中窗口的声音，语音软件不被采集，解决共享时回声问题。',
  },
  {
    icon: Zap,
    title: '自动节费管理',
    desc: '自动检测共享状态，严格管理滥用消耗，控制声网预算，无需手动干预。',
  },
  {
    icon: Monitor,
    title: '多画质可选',
    desc: '540p ~ 4K 多档画质自由切换，适应不同网络环境和清晰度需求。',
  },
  {
    icon: Settings,
    title: '服务器主自管理',
    desc: '每服务器独立管理面板，频道主可自行配置画质、Agora 凭证、超时参数，无需联系运维。',
  },
];

export default function HomePage() {
  const [showDeployModal, setShowDeployModal] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-surface-dark">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-20 glass-strong px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <p className="font-bold text-base leading-tight">Xgoat.Cast</p>
            <p className="text-xs text-dim">小羊屏幕共享</p>
          </div>
        </div>
        <nav className="flex items-center gap-2 sm:gap-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
          >
            <Github className="w-4 h-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </nav>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-20">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-xs text-brand-light mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
          基于 Agora 声网 + NestJS
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold gradient-text mb-4">
          Xgoat.Cast · 小羊屏幕共享
        </h1>
        <p className="text-muted text-base sm:text-lg max-w-2xl mb-8 leading-relaxed">
          聊天软件快捷屏幕共享工具。频道内发条消息即可发起，
          观众免登录观看，支持低延迟直播模式，可独立共享窗口声音，不采集语音软件音频。
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => setShowDeployModal(true)}
            className="btn-brand px-5 py-2.5 rounded-full text-white font-medium text-sm"
          >
            部署到 KOOK
          </button>
          <span className="group relative px-5 py-2.5 rounded-full bg-white/5 border border-white/5 text-sm text-muted opacity-40 hover:opacity-60 transition-opacity cursor-default">
            部署到 Discord
            <span className="absolute -top-9 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-white/10 text-xs text-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              即将上线
            </span>
          </span>
          <span className="group relative px-5 py-2.5 rounded-full bg-white/5 border border-white/5 text-sm text-muted opacity-40 hover:opacity-60 transition-opacity cursor-default">
            部署到 QQ 群
            <span className="absolute -top-9 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-white/10 text-xs text-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              即将上线
            </span>
          </span>
          <span className="text-sm text-dim">…</span>
        </div>
      </section>

      {/* 功能特性 */}
      <section className="px-6 pb-20 max-w-5xl w-full mx-auto">
        <h2 className="text-center text-2xl font-bold mb-10">功能特性</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="glass rounded-2xl p-5 hover:border-brand/30 border border-transparent transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-brand/10 flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-brand-light" />
                </div>
                <h3 className="font-semibold text-sm mb-1.5">{f.title}</h3>
                <p className="text-xs text-muted leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* 底部 */}
      <footer className="border-t border-white/5 px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <div>
            <p className="text-sm font-medium">Xgoat.Cast</p>
            <p className="text-xs text-dim">
              © {new Date().getFullYear()} Xgoat.Cast · 由 {DEVELOPER} 开发
            </p>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={`mailto:${EMAIL}`}
              className="flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors"
            >
              <Mail className="w-3.5 h-3.5" />
              {EMAIL}
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </footer>

      {/* 部署指南弹框 */}
      {showDeployModal && <DeployGuideModal onClose={() => setShowDeployModal(false)} />}
    </div>
  );
}

// ===== Deploy Guide Modal =====

const KOOK_BOT_INVITE_URL = 'https://www.kookapp.cn/app/oauth2/authorize?id=50059&permissions=4096&client_id=d19eUmgWre4go8mW&redirect_uri=&scope=bot';

function DeployGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="glass rounded-2xl p-6 w-full max-w-md">
        <h2 className="text-lg font-bold text-white mb-4">使用指南</h2>

        <div className="space-y-4 mb-6">
          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">1</div>
            <div>
              <p className="text-sm font-medium text-white">添加机器人到服务器</p>
              <p className="text-xs text-muted mt-1">点击下方按钮，选择要添加的 KOOK 服务器完成授权。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">2</div>
            <div>
              <p className="text-sm font-medium text-white">绑定管理面板</p>
              <p className="text-xs text-muted mt-1">机器人加入后自动向频道主发送绑定卡片。若未收到，频道主发送 <code className="bg-white/10 px-1 rounded">/xchelp</code> 重新调起。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">3</div>
            <div>
              <p className="text-sm font-medium text-white">配置声网凭证</p>
              <p className="text-xs text-muted mt-1">点击绑定卡片进入管理面板，设置密码后配置 Agora App ID 和 App Certificate。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">4</div>
            <div>
              <p className="text-sm font-medium text-white">发起屏幕共享</p>
              <p className="text-xs text-muted mt-1">在 KOOK 频道发送「屏幕共享」，机器人自动推送共享卡片，点击即可开始。</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm text-muted hover:text-white hover:bg-white/5 transition-colors"
          >
            关闭
          </button>
          <a
            href={KOOK_BOT_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 btn-brand py-2.5 rounded-xl text-white font-medium text-sm text-center"
          >
            邀请机器人
          </a>
        </div>
      </div>
    </div>
  );
}
