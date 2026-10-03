import { useEffect, useState } from 'react';
import { panelRequest } from '../../lib/panels';
export default function MailSettingsPanel() {
  const [config, setConfig] = useState<any>(null), [secret, setSecret] = useState({ password: '', secretKey: '' }), [to, setTo] = useState('');
  const [savedConfig, setSavedConfig] = useState<any>(null);
  const [template, setTemplate] = useState<{ html: string; preview: string } | null>(null), [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { panelRequest('super/mail-settings').then(data => { setConfig(data); setSavedConfig(data); }).catch(e => setMessage(e.message)); }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(''); try { await action(); } catch (e: any) { setMessage(e.message); } finally { setBusy(false); } };
  const input = 'w-full rounded-lg bg-surface-dark border border-white/10 px-3 py-2 text-white';
  const ses = config?.provider === 'tencent-ses';
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig) || !!secret.password || !!secret.secretKey;
  const loadTemplate = async () => {
    if (template) return template;
    const data = await panelRequest<{ html: string; preview: string }>('super/mail-settings/template');
    setTemplate(data); return data;
  };
  return <section className="glass rounded-2xl p-6 space-y-4"><h2 className="text-xl font-semibold">邮件服务</h2><p className="text-sm text-muted">用于面板注册和找回密码。保存后立即生效，无需重启。</p>
    {config && <form onSubmit={e => { e.preventDefault(); void run(async () => { const saved = await panelRequest('super/mail-settings', { ...config, ...secret }, 'PUT'); setConfig(saved); setSavedConfig(saved); setSecret({ password: '', secretKey: '' }); setMessage('邮件配置已保存，请发送测试邮件验证实际收信'); }); }}><fieldset disabled={busy} className="space-y-4">
      <label className="block text-sm">发信方式<select className={input} value={config.provider || 'smtp'} onChange={e => setConfig({ ...config, provider: e.target.value })}><option value="smtp">SMTP（任意邮箱服务商）</option><option value="tencent-ses">腾讯云邮件推送 SES（API 发信）</option></select></label>
      {ses ? <>
        <div className="rounded-xl border border-orange-400/20 bg-orange-400/5 p-4 text-sm leading-relaxed text-orange-100">使用腾讯云 API 发送验证码，无需 SMTP。请确认发信域名已验证、发信地址已创建，且模板已审核通过；三者应位于所选地域。</div>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block text-sm">腾讯云 SecretId<input className={input} type="text" autoComplete="off" required value={config.secretId || ''} onChange={e => setConfig({ ...config, secretId: e.target.value })} /></label>
          <label className="block text-sm">腾讯云 SecretKey<input className={input} type="password" autoComplete="new-password" value={secret.secretKey} placeholder={config.secretKeySet ? '已设置，留空保留' : '请输入 SecretKey'} required={!config.secretKeySet} onChange={e => setSecret({ ...secret, secretKey: e.target.value })} /></label>
          <label className="block text-sm">发件邮箱（已验证的发信地址）<input className={input} type="email" required value={config.from || ''} onChange={e => setConfig({ ...config, from: e.target.value })} /></label>
          <label className="block text-sm">地域<select className={input} value={config.region || 'ap-guangzhou'} onChange={e => setConfig({ ...config, region: e.target.value })}><option value="ap-guangzhou">广州（ap-guangzhou）</option><option value="ap-hongkong">香港（ap-hongkong）</option></select></label>
          <label className="block text-sm">模板 ID（需审核通过）<input className={input} type="text" inputMode="numeric" pattern="[1-9][0-9]*" required value={config.templateId || ''} onChange={e => setConfig({ ...config, templateId: e.target.value })} /></label>
        </div>
        <p className="text-xs text-muted leading-relaxed">SecretKey 留空可保留已保存的密钥；更换 SecretId 时需同时填写配套的 SecretKey。下载下方 HTML 模板，在腾讯云创建「HTML 富文本」模板并上传，模板只需保留 {'{{code}}'} 一个变量。更新模板后需等待审核通过。</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="rounded-lg bg-white/10 px-4 py-2 text-sm" onClick={() => run(async () => { await loadTemplate(); setShowPreview(!showPreview); })}>{showPreview ? '收起模板预览' : '预览邮件模板'}</button>
          <button type="button" className="rounded-lg bg-white/10 px-4 py-2 text-sm" onClick={() => run(async () => {
            const data = await loadTemplate();
            const url = URL.createObjectURL(new Blob([data.html], { type: 'text/html;charset=utf-8' }));
            const link = document.createElement('a'); link.href = url; link.download = 'ses-email-template.html';
            document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            setMessage('模板已下载，请上传到腾讯云邮件模板并等待审核');
          })}>下载 SES 模板</button>
        </div>
        {showPreview && template && <div className="space-y-2"><p className="text-xs text-muted">预览使用示例验证码；真实邮件会自动替换为本次验证码。</p><iframe title="验证码邮件模板预览" sandbox="" srcDoc={template.preview} className="w-full h-[760px] rounded-xl border border-white/10 bg-[#f4f3f0]" /></div>}
      </> : <>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block text-sm">SMTP 主机<input className={input} type="text" required value={config.host || ''} onChange={e => setConfig({ ...config, host: e.target.value })} /></label>
          <label className="block text-sm">SMTP 账号<input className={input} type="text" required value={config.user || ''} onChange={e => setConfig({ ...config, user: e.target.value })} /></label>
          <label className="block text-sm">端口<input className={input} type="number" min={1} max={65535} required value={config.port} onChange={e => setConfig({ ...config, port: Number(e.target.value) })} /></label>
          <label className="block text-sm">加密方式<select className={input} value={String(config.secure)} onChange={e => setConfig({ ...config, secure: e.target.value === 'true' })}><option value="true">SSL/TLS（通常 465）</option><option value="false">STARTTLS（通常 587）</option></select></label>
          <label className="block text-sm">发件邮箱<input className={input} type="email" required value={config.from || ''} onChange={e => setConfig({ ...config, from: e.target.value })} /></label>
          <label className="block text-sm">发件人显示名称（选填）<input className={input} type="text" maxLength={64} placeholder="如：Xgoat.Cast" value={config.fromName || ''} onChange={e => setConfig({ ...config, fromName: e.target.value })} /></label>
          <label className="block text-sm">密码或授权码<input className={input} type="password" autoComplete="new-password" value={secret.password} placeholder={config.passwordSet ? '已设置，留空保留' : '请输入密码或授权码'} required={!config.passwordSet} onChange={e => setSecret({ ...secret, password: e.target.value })} /></label>
        </div>
      </>}
      <button className="btn-brand px-4 py-2 rounded-lg" type="submit">保存邮件配置</button></fieldset></form>}
    <div className="border-t border-white/10 pt-4 space-y-3"><p className="text-sm text-muted">{dirty ? '配置有未保存的修改，请先保存后测试。' : '以下操作使用已保存的配置；保存成功不代表已通过发信验证。'}</p>
      {!ses && <button disabled={busy || dirty || !savedConfig?.ready} className="rounded-lg bg-white/10 px-4 py-2 disabled:opacity-40" onClick={() => run(async () => { await panelRequest('super/mail-settings/test', {}); setMessage('邮件服务器连接与认证成功'); })}>检查连接</button>}
      <div className="flex flex-col sm:flex-row gap-3"><input aria-label="测试收件邮箱" className={input} type="email" placeholder="测试收件邮箱" value={to} onChange={e => setTo(e.target.value)} /><button disabled={busy || dirty || !savedConfig?.ready || !to} className="shrink-0 rounded-lg bg-white/10 px-4 py-2 disabled:opacity-40" onClick={() => run(async () => {
        const result = await panelRequest('super/mail-settings/test', { to });
        setMessage(`${ses ? '腾讯云 API 已受理测试邮件' : '测试邮件已提交'}，请检查收件箱和垃圾箱${result.messageId ? `。邮件 ID：${result.messageId}` : ''}${result.requestId ? `；请求 ID：${result.requestId}` : ''}`);
      })}>发送测试邮件</button></div></div>
    {message && <p role="status" className="break-all text-sm text-amber-200">{message}</p>}
  </section>;
}
