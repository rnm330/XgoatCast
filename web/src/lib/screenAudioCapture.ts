/**
 * 全局劫持 navigator.mediaDevices.getDisplayMedia，注入顶层 windowAudio: "window"。
 *
 * 背景：
 * - Chrome 141+ 原生支持 `windowAudio` 顶层 preference hint（W3C DisplayMediaStreamOptions）
 * - 设置 windowAudio: "window" 后，用户选「窗口」时只捕获该窗口进程的音频，
 *   Discord/飞书/语音软件等其他进程的音频不会被录入 → 解决跨进程回声
 * - Agora SDK 的 ScreenVideoTrackInitConfig.windowAudio 仅支持 "exclude"|"system"，
 *   不支持 "window"，因此必须通过劫持原生 GDM 注入
 * - 旧浏览器（Chrome <141）会静默忽略未知的顶层属性，无副作用
 *
 * 参考：
 * - chromestatus 5072779506089984 (desktop_first: 141)
 * - W3C mediacapture-screen-share WebIDL: DisplayMediaStreamOptions / WindowAudioPreferenceEnum
 * - 2026-07-18.md 13:33 决定性实验结论：Agora createScreenVideoTrack 对被劫持的 GDM 返回的窗口音频轨不做过滤
 */

let installed = false;

export function installScreenAudioInterceptor(): void {
  if (installed) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return;

  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = (
    constraints?: DisplayMediaStreamOptions,
  ): Promise<MediaStream> => {
    // windowAudio: "window" 是 W3C 顶层 preference hint
    // Chrome 141+ 生效：用户选「窗口」时只捕获该窗口进程音频
    // 旧浏览器静默忽略，降级为原来的行为（整个系统音频）
    // 注意：windowAudio 不在 TS 的 DisplayMediaStreamOptions 类型里（非标准 / 新属性），
    // 用 as any 整体转型绕过类型检查，运行时浏览器原生识别
    const patched = {
      ...constraints,
      windowAudio: 'window',
    } as DisplayMediaStreamOptions;
    return original(patched);
  };

  installed = true;
}
