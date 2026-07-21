/** 转义 KOOK KMarkdown 中的特殊字符，防止用户名中的 `*`、`_`、`[`、`]` 等导致排版异常 */
function escapeMarkdown(s: string): string {
  return s.replace(/([*_\[\]`~\\])/g, '\\$1');
}

/** 发起共享时回复给用户的共享链接卡片（同时带「开始共享」与「点击观看」按钮） */
export function buildShareLinkCard(opts: {
  sharerUsername: string;
  shareUrl: string;
  viewUrl?: string;
}): unknown {
  const safeName = escapeMarkdown(opts.sharerUsername || '用户');
  const buttons: unknown[] = [
    {
      type: 'button',
      text: { type: 'plain-text', content: '🖥 开始共享' },
      theme: 'success',
      click: 'link',
      value: opts.shareUrl,
    },
  ];
  // 即便共享还没开始，「点击观看」也能在共享开启后直接观看
  if (opts.viewUrl) {
    buttons.push({
      type: 'button',
      text: { type: 'plain-text', content: '▶ 点击观看' },
      theme: 'primary',
      click: 'link',
      value: opts.viewUrl,
    });
  }
  return [
    {
      type: 'card',
      theme: 'primary',
      size: 'lg',
      modules: [
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: '**Xgoat.Cast 小羊屏幕共享已创建** 🐑\n' + safeName + '，点击下方按钮开始共享你的屏幕。',
          },
        },
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: '💡 **使用说明**\n• 点击「开始共享」后在浏览器中授权屏幕采集，记得打开声音权限\n• 频道成员可随时点击「点击观看」免登录观看\n• 关闭网页后链接会在短时间内自动失效\n• 无人观看时，一定要及时停止共享，节省服务器费用！',
          },
        },
        { type: 'divider' },
        {
          type: 'action-group',
          elements: buttons,
        },
      ],
    },
  ];
}

/** 共享结束后更新原卡片的状态（用于更新已存在的共享卡片） */
export function buildEndedShareCard(opts: {
  sharerUsername: string;
  totalViewerJoins: number;
  durationMs: number | null;
  standardMinutes: number;
  estimatedCost: number;
}): unknown {
  const safeName = escapeMarkdown(opts.sharerUsername || '匿名用户');
  const totalSeconds = opts.durationMs ? Math.max(0, Math.round(opts.durationMs / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const durationText = hours > 0
    ? `${hours}小时${minutes}分${seconds}秒`
    : `${minutes}分${seconds}秒`;
  const cost = opts.estimatedCost.toFixed(2);

  return [
    {
      type: 'card',
      theme: 'secondary',
      size: 'lg',
      modules: [
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: '**屏幕共享已结束** 🐑\n' + safeName + ' 的屏幕共享已结束',
          },
        },
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content:
              `📊 **统计信息**\n` +
              `• 观看总人数：${opts.totalViewerJoins} 人\n` +
              `• 屏幕共享总时长：${durationText}\n` +
              `• 消耗标准时长：${opts.standardMinutes} 分钟\n` +
              `• 约合费用：¥${cost}`,
          },
        },
        {
          type: 'action-group',
          elements: [
            {
              type: 'button',
              text: { type: 'plain-text', content: '🔄 重新发起共享' },
              theme: 'primary',
              click: 'return-val',
              value: 'reshare',
            },
          ],
        },
      ],
    },
  ];
}

/** 帮助指令卡片（可附带「发起屏幕共享」按钮） */
export function buildHelpCard(opts?: { triggerWords?: string; showShareButton?: boolean }): unknown {
  const triggers = opts?.triggerWords || '屏幕共享,共享屏幕';
  const firstTrigger = triggers.split(',')[0];
  const modules: any[] = [
    {
      type: 'section',
      text: {
        type: 'kmarkdown',
        content: '**🐑 Xgoat.Cast · 使用说明**',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'kmarkdown',
        content: `**发起屏幕共享**\n频道内发送 \`${firstTrigger}\` 即可，机器人自动推送共享卡片`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'kmarkdown',
        content: '**可用指令**\n• `/xchelp` — 查看使用说明、绑定和管理面板',
      },
    },
  ];

  // 附加「发起屏幕共享」按钮
  if (opts?.showShareButton) {
    modules.push({ type: 'divider' });
    modules.push({
      type: 'action-group',
      elements: [
        {
          type: 'button',
          text: { type: 'plain-text', content: '🖥 发起屏幕共享' },
          theme: 'success',
          click: 'return-val',
          value: 'start_share',
        },
      ],
    });
  }

  return [
    {
      type: 'card',
      theme: 'secondary',
      size: 'lg',
      modules,
    },
  ];
}

/** 绑定管理面板卡片（发送给频道主） */
export function buildBindCard(opts: {
  guildName: string;
  openId?: string;
  serverId?: string;
  bindUrl: string;
}): unknown {
  const idLabel = opts.openId ? `公开 ID：\`${opts.openId}\`` : (opts.serverId ? `服务器 ID：\`${opts.serverId}\`` : '');
  return [
    {
      type: 'card',
      theme: 'primary',
      size: 'lg',
      modules: [
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: `**🐑 Xgoat.Cast 屏幕共享机器人已加入服务器**\n\n服务器：**${opts.guildName}**${idLabel ? '\n' + idLabel : ''}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: '作为频道主，您需要绑定管理面板来配置屏幕共享设置（画质选项、声网凭证等）。\n\n请点击下方按钮前往绑定页面，设置管理密码后即可使用。',
          },
        },
        { type: 'divider' },
        {
          type: 'action-group',
          elements: [
            {
              type: 'button',
              text: { type: 'plain-text', content: '🔗 前往绑定管理面板' },
              theme: 'primary',
              click: 'link',
              value: opts.bindUrl,
            },
          ],
        },
      ],
    },
  ];
}

/** 已绑定提示卡片（服务器已绑定时回复给发起 /xchelp 的频道主） */
export function buildAlreadyBoundCard(opts: {
  guildName: string;
  manageUrl: string;
  triggerWords?: string;
}): unknown {
  const triggers = opts.triggerWords || '屏幕共享,共享屏幕';
  return [
    {
      type: 'card',
      theme: 'warning',
      size: 'lg',
      modules: [
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: `**🐑 Xgoat.Cast 管理面板已绑定**\n\n服务器：**${opts.guildName}**\n\n该服务器的管理面板已经绑定完成。`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: `**发起屏幕共享**\n频道内发送 \`${triggers.split(',')[0]}\` 即可`,
          },
        },
        { type: 'divider' },
        {
          type: 'action-group',
          elements: [
            {
              type: 'button',
              text: { type: 'plain-text', content: '⚙️ 打开管理面板' },
              theme: 'primary',
              click: 'link',
              value: opts.manageUrl,
            },
          ],
        },
      ],
    },
  ];
}

/** 绑定请求卡片（带临时 token 的绑定链接，10 分钟有效） */
export function buildBindRequestCard(opts: {
  guildName: string;
  openId?: string;
  serverId?: string;
  bindUrl: string;
}): unknown {
  const idLabel = opts.openId ? `公开 ID：\`${opts.openId}\`` : (opts.serverId ? `服务器 ID：\`${opts.serverId}\`` : '');
  return [
    {
      type: 'card',
      theme: 'primary',
      size: 'lg',
      modules: [
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: `**🐑 Xgoat.Cast 绑定管理面板**\n\n服务器：**${opts.guildName}**${idLabel ? '\n' + idLabel : ''}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'kmarkdown',
            content: '作为频道主，您需要绑定管理面板来配置屏幕共享设置（画质选项、声网凭证等）。\n\n⚠️ **绑定链接 10 分钟内有效**，过期后需重新发送 `/xchelp` 命令获取。',
          },
        },
        { type: 'divider' },
        {
          type: 'action-group',
          elements: [
            {
              type: 'button',
              text: { type: 'plain-text', content: '🔗 前往绑定管理面板' },
              theme: 'primary',
              click: 'link',
              value: opts.bindUrl,
            },
          ],
        },
      ],
    },
  ];
}

