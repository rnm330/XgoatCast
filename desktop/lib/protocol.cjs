const PRESETS = {
  '480p_2': [640,480,30], '720p30': [1280,720,30], '1080p_2': [1920,1080,30],
  '1080p60': [1920,1080,60], '1440p30': [2560,1440,30], '1440p60': [2560,1440,60], '4k30': [3840,2160,30],
};
function parseLaunch(input) {
  const uri = new URL(input);
  if (uri.protocol !== 'xgoatcast:' || uri.hostname !== 'share' || uri.pathname && uri.pathname !== '/') throw new Error('不是有效的 XgoatCast 共享链接');
  const server = new URL(uri.searchParams.get('server'));
  if (server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new Error('服务器地址必须是网站根地址');
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(server.hostname))) throw new Error('共享服务器需要 HTTPS（本机调试除外）');
  const token = uri.searchParams.get('t') || '';
  const clientId = uri.searchParams.get('cid') || '';
  if (!/^[a-zA-Z0-9_-]{16,256}$/.test(token) || !/^[a-zA-Z0-9_-]{16,128}$/.test(clientId)) throw new Error('共享链接缺少有效的会话参数');
  const quality = uri.searchParams.get('quality') || '1080p_2';
  if (!PRESETS[quality]) throw new Error('不支持的画质');
  return { server: server.origin, token, clientId, quality, lowLatency: uri.searchParams.get('lowLatency') === '1', optimizationMode: uri.searchParams.get('optimizationMode') === 'detail' ? 'detail' : 'motion' };
}
module.exports = { parseLaunch, PRESETS };
