import type { HeychatCardMessage } from './heychat.types';

function plain(text: string) {
  return { type: 'plain-text', text };
}

function section(...paragraph: any[]) {
  return { type: 'section', paragraph };
}

function linkButton(text: string, value: string, theme = 'primary') {
  return { type: 'button', event: 'link-to', value, text, theme };
}

function serverButton(text: string, value: string, theme = 'primary') {
  return { type: 'button', event: 'server', value, text, theme };
}

function card(modules: any[]): HeychatCardMessage {
  return { data: [{ type: 'card', modules }] };
}

export function buildHeychatViewingCard(options: {
  sharerUsername: string;
  viewUrl: string;
}): HeychatCardMessage {
  return card([
    section(plain('🐑 Xgoat.Cast 屏幕共享已开始')),
    section(plain(`${options.sharerUsername || '用户'} 正在共享屏幕`)),
    { type: 'button-group', btns: [linkButton('点击观看', options.viewUrl, 'success')] },
  ]);
}

export function buildHeychatShareStartCard(options: {
  sharerUsername: string;
  shareUrl: string;
}): HeychatCardMessage {
  return card([
    section(plain('🐑 Xgoat.Cast 屏幕共享已创建')),
    section(plain(`${options.sharerUsername || '用户'} 发起了一个共享会话`)),
    section(plain('点击下方按钮开始共享，开始后机器人会在当前频道发布观看卡片。')),
    { type: 'button-group', btns: [linkButton('点击开始共享', options.shareUrl, 'success')] },
  ]);
}

export function buildHeychatBindingCard(options: {
  roomName: string;
  bindUrl: string;
}): HeychatCardMessage {
  return card([
    section(plain('🐑 Xgoat.Cast 房间管理绑定')),
    section(plain(`房间「${options.roomName || '当前房间'}」的房主可打开绑定页面。`)),
    section(plain('打开页面后，请只在当前页面显示的设备码对应的浏览器中完成绑定。')),
    { type: 'button-group', btns: [linkButton('打开绑定页面', options.bindUrl, 'success')] },
  ]);
}

export function buildHeychatEndedCard(options: {
  sharerUsername: string;
  totalViewerJoins: number;
  durationMs: number | null;
  standardMinutes: number;
  estimatedCost: number;
}): HeychatCardMessage {
  const totalSeconds = options.durationMs
    ? Math.max(0, Math.round(options.durationMs / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const duration = hours > 0
    ? `${hours}小时${minutes}分${seconds}秒`
    : `${minutes}分${seconds}秒`;
  return card([
    section(plain('🐑 Xgoat.Cast 屏幕共享已结束')),
    section(plain(`${options.sharerUsername || '用户'} 的共享已结束`)),
    section(plain(
      `观看总人数：${options.totalViewerJoins} 人\n` +
      `共享时长：${duration}\n` +
      `标准时长：${options.standardMinutes} 分钟\n` +
      `预估费用：¥${options.estimatedCost.toFixed(2)}`,
    )),
    { type: 'button-group', btns: [serverButton('重新发起共享', 'reshare')] },
  ]);
}
