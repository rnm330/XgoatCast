import { useRef, useState } from 'react';
import { Github, Monitor, MonitorUp, Users, Zap, Settings, Mail, ExternalLink, Gauge, Volume2, Play, ArrowRight, ChevronDown, Link2, SlidersHorizontal } from 'lucide-react';

const GITHUB_URL = 'https://github.com/rnm330/XgoatCast';
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
  const [showHeychatModal, setShowHeychatModal] = useState(false);
  const [showQqModal, setShowQqModal] = useState(false);
  const deployMenu = useRef<HTMLDetailsElement>(null);
  const chooseDeploy = (platform: 'kook' | 'heychat') => {
    if (deployMenu.current) deployMenu.current.open = false;
    if (platform === 'kook') setShowDeployModal(true);
    else setShowHeychatModal(true);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-20 bg-[#f8f8f6]/95 border-b border-[#d9ddd6] px-5 sm:px-8">
        <div className="max-w-7xl mx-auto py-4 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-3 min-w-0" aria-label="Xgoat.Cast 屏幕共享首页">
          <span className="w-10 h-10 rounded-lg bg-brand flex items-center justify-center shrink-0" aria-hidden="true"><Monitor size={23} strokeWidth={1.7} /></span>
          <span className="font-semibold text-base sm:text-lg truncate">Xgoat.Cast<span className="hidden sm:inline"> 屏幕共享</span></span>
        </a>
        <nav className="flex items-center gap-3 sm:gap-6 shrink-0">
          <a href="/downloads.html" className="text-sm text-[#a94004] hover:underline underline-offset-4">客户端下载</a>
          <a href="/updates.html" className="text-sm text-muted hover:text-[#20211f] transition-colors">更新日志</a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted hover:text-[#20211f] transition-colors"
          >
            <Github className="w-4 h-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </nav>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <section className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20 lg:py-24 grid lg:grid-cols-[0.95fr_1.05fr] gap-12 lg:gap-16 items-center">
          <div className="home-hero-copy">
            <h1 className="text-4xl sm:text-5xl lg:text-[3.55rem] leading-[1.14] tracking-[-0.03em] font-semibold">Xgoat.Cast<br />屏幕共享</h1>
            <p className="mt-8 text-base sm:text-lg text-muted leading-[1.9] max-w-[34rem]">通过自建共享面板或语音软件机器人快速发起屏幕共享，让他人打开链接即可观看。</p>
            <div className="mt-10 flex flex-wrap gap-3 items-start">
              <a href="/panels/register" className="btn-brand inline-flex items-center justify-center gap-3 rounded-lg px-6 py-3.5 text-base font-medium">自建共享面板 <ArrowRight size={18} /></a>
              <details ref={deployMenu} className="relative group">
                <summary className="list-none cursor-pointer inline-flex items-center justify-center gap-3 rounded-lg border border-[#bfc5ba] bg-[#fffefd] px-6 py-3.5 text-base font-medium hover:border-[#8c9488] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">部署到语音软件 <ChevronDown size={17} className="group-open:rotate-180 transition-transform" /></summary>
                <div className="absolute top-full left-0 mt-2 w-64 rounded-xl border border-[#d9ddd6] bg-[#fffefd] shadow-[0_16px_36px_rgba(38,40,37,.12)] p-2 z-30">
                  <button type="button" onClick={() => chooseDeploy('kook')} className="w-full text-left rounded-lg px-4 py-3 text-sm hover:bg-[#f3f4f0]">KOOK</button>
                  <button type="button" onClick={() => chooseDeploy('heychat')} className="w-full text-left rounded-lg px-4 py-3 text-sm hover:bg-[#f3f4f0]">黑盒语音</button>
                  <button type="button" onClick={() => { if (deployMenu.current) deployMenu.current.open = false; setShowQqModal(true); }} className="w-full text-left rounded-lg px-4 py-3 text-sm hover:bg-[#f3f4f0]">QQ 群</button>
                  <div className="px-4 py-3 text-sm text-dim" aria-disabled="true">Discord · 即将上线</div>
                </div>
              </details>
            </div>
          </div>
          <div className="home-panel-preview-wrap">
            <div className="home-panel-preview" role="img" aria-label="自建共享面板网页预览：橙子的小站，提供发起共享和正在进行的共享列表">
              <div className="home-panel-preview-header"><span>橙子的小站</span><span>管理</span></div>
              <div className="home-panel-preview-content">
                <h2>橙子的小站</h2>
                <p>进入共享观看，或发起一次新的屏幕共享。</p>
                <div className="home-panel-preview-card">
                  <div><h3>发起共享</h3><p>创建共享并与他人共享屏幕</p></div>
                  <span className="home-panel-preview-action"><MonitorUp size={17} strokeWidth={1.7} />发起共享</span>
                </div>
                <h3 className="home-panel-preview-list-title">正在进行的共享</h3>
                <div className="home-panel-preview-row"><MonitorUp size={19} strokeWidth={1.7} /><span>共享人：蜜桃</span><small>2 人观看</small></div>
              </div>
              <div className="home-panel-preview-footer">橙子的小站 Powered by Xgoat.Cast™<small>Xgoateam™</small></div>
            </div>
          </div>
        </section>

        <section className="border-t border-[#d9ddd6] bg-[#eef0eb] px-5 sm:px-8 py-14 sm:py-16">
          <div className="max-w-7xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-semibold">四步开始共享</h2>
            <div className="mt-9 grid sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8">
              {[
                { icon: SlidersHorizontal, title: '选择使用方式', desc: '开通自建共享面板，或部署到语音软件。' },
                { icon: Settings, title: '填写声网账户资料', desc: '在管理后台配置自己的 Agora 凭证。' },
                { icon: Monitor, title: '发起屏幕共享', desc: '选择画面与声音，开始共享。' },
                { icon: Link2, title: '打开链接观看', desc: '把观看链接发给其他人。' },
              ].map(step => <div key={step.title} className="home-step border-t border-[#cbd0c7] pt-5"><step.icon size={24} className="text-brand-light" strokeWidth={1.7} /><h3 className="mt-4 font-semibold">{step.title}</h3><p className="mt-2 text-sm text-muted leading-relaxed">{step.desc}</p></div>)}
            </div>
          </div>
        </section>

      <section className="flex-1 border-t border-[#d9ddd6] bg-[#fffefd] px-5 sm:px-8 py-14 sm:py-20">
        <div className="max-w-7xl w-full mx-auto">
        <h2 className="text-2xl sm:text-3xl font-semibold mb-8">功能特性</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-14">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="home-feature-row flex gap-5 py-6 border-t border-[#d9ddd6]">
                <div className="home-feature-icon w-10 h-10 rounded-lg bg-[#ffe9dc] flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-brand-light" strokeWidth={1.7} />
                </div>
                <div><h3 className="font-semibold text-base mb-1.5">{f.title}</h3><p className="text-sm text-muted leading-relaxed">{f.desc}</p></div>
              </div>
            );
          })}
        </div>
        </div>
      </section>
      </main>

      {/* 底部 */}
      <footer className="border-t border-[#d9ddd6] bg-[#f8f8f6] px-5 sm:px-8 py-7">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <p className="text-xs text-dim">2026 Powered by Xgoateam™</p>
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
            <a
              href="https://space.bilibili.com/2106297"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors"
            >
              <BilibiliIcon className="w-3.5 h-3.5" />
              Bilibili
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </footer>

      {/* 部署指南弹框 */}
      {showDeployModal && <DeployGuideModal onClose={() => setShowDeployModal(false)} />}
      {showHeychatModal && <HeychatDeployGuideModal onClose={() => setShowHeychatModal(false)} />}
      {showQqModal && <QqDeployGuideModal onClose={() => setShowQqModal(false)} />}
    </div>
  );
}

// ===== Deploy Guide Modal =====

const KOOK_BOT_INVITE_URL = 'https://www.kookapp.cn/app/oauth2/authorize?id=50059&permissions=4096&client_id=d19eUmgWre4go8mW&redirect_uri=&scope=bot';
const HEYCHAT_BOT_INVITE_URL = 'https://chat.xiaoheihe.cn/app/?bot_id=103252254';

function DeployGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="glass rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-bold text-white">使用指南</h2>
          <a
            href="https://www.bilibili.com/video/BV1zB3j6rETM"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-brand-light hover:underline shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            视频部署教程
          </a>
        </div>

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
              <p className="text-xs text-muted mt-1">机器人加入后自动向本次邀请人和服务器主分别发送绑定卡片。若未收到，服务器主发送 <code className="bg-white/10 px-1 rounded">/xchelp</code> 重新调起。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">3</div>
            <div>
              <p className="text-sm font-medium text-white">配置声网凭证</p>
              <p className="text-xs text-muted mt-1">
                点击绑定卡片进入管理面板，设置密码后配置声网 Agora App ID 和 App Certificate。
                <a href="https://console.agora.io/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">agora.io</a>
                国际站和
                <a href="https://console.shengwang.cn/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">shengwang.cn</a>
                国内站账户均支持，系统会自动匹配。
              </p>
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

function HeychatDeployGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="glass rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-bold text-white">黑盒语音使用指南</h2>
          <a
            href="https://www.bilibili.com/video/BV1Zy4S6zELB"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-brand-light hover:underline shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            视频部署教程
          </a>
        </div>

        <div className="space-y-4 mb-6">
          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">1</div>
            <div>
              <p className="text-sm font-medium text-white">添加机器人到房间</p>
              <p className="text-xs text-muted mt-1">点击下方按钮，选择要添加机器人的黑盒语音房间完成邀请。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">2</div>
            <div>
              <p className="text-sm font-medium text-white">绑定管理面板</p>
              <p className="text-xs text-muted mt-1">机器人加入后自动向房间主发送绑定卡片。若未收到，房间主发送 <code className="bg-white/10 px-1 rounded">/xchelp</code> 重新调起。打开绑定页面后，复制指令到房间发送完成授权。</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">3</div>
            <div>
              <p className="text-sm font-medium text-white">配置声网凭证</p>
              <p className="text-xs text-muted mt-1">
                授权后，设置密码进入管理面板，配置声网 Agora App ID 和 App Certificate。
                <a href="https://console.agora.io/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">agora.io</a>
                国际站和
                <a href="https://console.shengwang.cn/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">shengwang.cn</a>
                国内站账户均支持，系统会自动匹配。
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">4</div>
            <div>
              <p className="text-sm font-medium text-white">发起屏幕共享</p>
              <p className="text-xs text-muted mt-1">在房间内发送 <code className="bg-white/10 px-1 rounded">/屏幕共享</code>，机器人自动推送共享卡片，点击即可开始。</p>
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
            href={HEYCHAT_BOT_INVITE_URL}
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

function QqDeployGuideModal({ onClose }: { onClose: () => void }) {
  const steps = [
    { title: '添加机器人到QQ群', description: '打开下方机器人资料页，由群主或管理员将「XgoatCast屏幕共享机器人」添加到目标QQ群。' },
    { title: '获取绑定入口', description: '在群里 @XgoatCast屏幕共享机器人，发送「管理」，打开机器人回复的绑定链接。' },
    { title: '发送一次性绑定码', description: '复制绑定页上的完整内容「@XgoatCast屏幕共享机器人 绑定码」，回到群里发送，无需加“管理”。若QQ没有识别为有效提及，请点选机器人后发送。绑定码5分钟内有效。' },
    { title: '设置管理密码和声网配置', description: '回到刚才打开绑定页的同一个浏览器，设置本群管理密码，再填写声网 Agora App ID 和 App Certificate。每个群独立配置。' },
    { title: '开始共享与观看', description: '群成员 @机器人，发送「屏幕共享」，打开回复的网页开始共享。共享开始后，其他成员点击群内观看链接即可观看；发送「帮助」可查看说明。' },
  ];
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="qq-deploy-title" className="glass rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(event) => event.stopPropagation()}>
        <h2 id="qq-deploy-title" className="text-lg font-bold text-white mb-2">QQ群部署与使用指南</h2>
        <p className="text-xs text-brand-light mb-5">首次绑定由群主或管理员完成，配置后群成员均可发起共享。群内操作请先 @机器人。</p>
        <ol className="space-y-4 mb-6">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-brand/20 flex items-center justify-center text-xs text-brand-light font-bold flex-shrink-0 mt-0.5">{index + 1}</span>
              <div><p className="text-sm font-medium text-white">{step.title}</p><p className="text-xs text-muted mt-1 leading-relaxed">{step.description}</p></div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted mb-5">声网凭证可在 <a href="https://console.shengwang.cn/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">声网控制台</a> 或 <a href="https://console.agora.io/" target="_blank" rel="noopener noreferrer" className="text-brand-light hover:underline">Agora 控制台</a> 获取。</p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm text-muted hover:text-white hover:bg-white/5 transition-colors">关闭</button>
          <a href="https://bot.q.qq.com/s/v0KGYuBPPy" target="_blank" rel="noopener noreferrer" className="flex-1 btn-brand py-2.5 rounded-xl text-white font-medium text-sm text-center">打开机器人资料页</a>
        </div>
      </div>
    </div>
  );
}

function BilibiliIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="#00A1D6" className={className} aria-hidden="true">
      <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z" />
    </svg>
  );
}
