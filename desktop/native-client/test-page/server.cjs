const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {RtcTokenBuilder, RtcRole} = require('agora-token');

const root = path.resolve(__dirname, '../../..');
try { process.loadEnvFile(path.join(root, '.env.native-test')); } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const appId = process.env.XGOATCAST_TEST_AGORA_APP_ID || '';
const certificate = process.env.XGOATCAST_TEST_AGORA_CERTIFICATE || '';
const port = Number(process.env.XGOATCAST_TEST_PORT || 3531);
if (!/^[0-9a-f]{32}$/i.test(appId) || !/^[0-9a-f]{32}$/i.test(certificate)) {
  throw new Error('请在 .env.native-test 配置有效的 App ID 和 Certificate');
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('测试端口无效');

const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const sdkPath = require.resolve('agora-rtc-sdk-ng');
const knownQualities = ['480p_2', '720p30', '1080p_2', '1080p60', '1440p30', '1440p60', '4k30'];
// This is the temporary server's policy, not a client-side quality override.
const allowedQualities = [...new Set((process.env.XGOATCAST_TEST_ALLOWED_QUALITIES || '720p30,1080p_2,1080p60').split(',').map(value => value.trim()))];
if (!allowedQualities.length || allowedQualities.some(value => !knownQualities.includes(value))) throw new Error('测试服务器画质配置无效');
let session = createSession();

function createSession() {
  const id = crypto.randomBytes(10).toString('hex');
  return {
    token: crypto.randomBytes(24).toString('base64url'), channel: 'xc_native_test_' + id,
    status: 'pending', publisherClientId: null, lowLatency: false,
    quality: null, createdAt: Date.now(), heartbeatAt: 0,
    requests: {info:0, token:0, start:0},
  };
}
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}
function authorized(url) { return typeof url.searchParams.get('t') === 'string' && url.searchParams.get('t') === session.token; }
function info() {
  return {
    status: session.status, sharerUsername: '临时共享会话', publisherClientId: session.publisherClientId,
    viewerCount: 0, allowLowLatency: true, allowQualityPreference: true, lowLatency: session.lowLatency,
    allowedQualities,
    qualityBitrates: {
      '480p_2':{bitrateMax:1000}, '720p30':{bitrateMax:2500}, '1080p_2':{bitrateMax:5000},
      '1080p60':{bitrateMax:8000}, '1440p30':{bitrateMax:10000}, '1440p60':{bitrateMax:16000}, '4k30':{bitrateMax:20000},
    },
  };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks=[];let size=0;
    req.on('data', chunk => { size+=chunk.length;if(size>16*1024){reject(new Error('请求过大'));req.destroy();}else chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('JSON 无效')); } });
    req.on('error', reject);
  });
}
function rtcToken(role, uid) {
  const expiresAt = Math.floor(Date.now()/1000) + 3600;
  return RtcTokenBuilder.buildTokenWithUid(appId, certificate, session.channel, uid, role, expiresAt, expiresAt);
}
setInterval(() => {
  if (session.status === 'active' && Date.now() - session.heartbeatAt > 8000) {
    session.status='pending';session.publisherClientId=null;session.heartbeatAt=0;
  }
}, 1000).unref();

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method==='GET' && url.pathname==='/') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Content-Length':page.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(page);return;
    }
    if (req.method==='GET' && url.pathname==='/agora-sdk.js') {
      const stat=fs.statSync(sdkPath);res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':stat.size,'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});fs.createReadStream(sdkPath).pipe(res);return;
    }
    if (req.method==='POST' && url.pathname==='/test/session') { session=createSession();json(res,200,{token:session.token,channel:session.channel});return; }
    if (req.method==='GET' && url.pathname==='/test/session') { json(res,200,{token:session.token,channel:session.channel,quality:session.quality,requests:session.requests,...info()});return; }
    if (req.method==='GET' && url.pathname==='/api/share/info') {
      if(!authorized(url)){json(res,401,{message:'测试会话无效'});return;}session.requests.info++;json(res,200,info());return;
    }
    if (req.method==='GET' && url.pathname==='/api/share/token') {
      if(!authorized(url)){json(res,401,{message:'测试会话无效'});return;}
      session.requests.token++;const publisher=url.searchParams.get('role')==='publisher';const uid=publisher?1:crypto.randomInt(100,99999);
      json(res,200,{token:rtcToken(publisher?RtcRole.PUBLISHER:RtcRole.SUBSCRIBER,uid),channel:session.channel,uid,appId,expireSec:3600});return;
    }
    if (req.method==='POST' && url.pathname==='/api/share/start') {
      if(!authorized(url)){json(res,401,{message:'测试会话无效'});return;}const body=await readBody(req);
      if(!allowedQualities.includes(body.quality)||typeof body.clientId!=='string'||body.clientId.length<16){json(res,400,{ok:false,message:'启动参数无效'});return;}
      if(session.status==='active'&&session.publisherClientId!==body.clientId){json(res,200,{ok:false,message:'已有客户端共享'});return;}
      session.status='active';session.publisherClientId=body.clientId;session.lowLatency=!!body.lowLatency;session.quality=body.quality;session.heartbeatAt=Date.now();session.requests.start++;json(res,200,{ok:true});return;
    }
    if (req.method==='POST' && url.pathname==='/api/share/heartbeat') {
      if(!authorized(url)){json(res,401,{message:'测试会话无效'});return;}const body=await readBody(req);
      const ok=session.status==='active'&&body.clientId===session.publisherClientId;if(ok)session.heartbeatAt=Date.now();json(res,200,{ok});return;
    }
    if (req.method==='POST' && url.pathname==='/api/share/stop') {
      if(!authorized(url)){json(res,401,{message:'测试会话无效'});return;}
      session.status='pending';session.publisherClientId=null;session.heartbeatAt=0;json(res,200,{ok:true});return;
    }
    json(res,404,{message:'Not found'});
  } catch(error) { json(res,500,{message:error?.message || '测试服务错误'}); }
});
server.listen(port,'127.0.0.1',()=>console.log(`XgoatCast 客户端测试页：http://localhost:${port}`));
