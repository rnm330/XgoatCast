// Login/upload protocol adapted from Jursin/lanzou-next (MIT); see third-party notice.
const fs = require('node:fs');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const BASE = 'https://up.woozooo.com';
const LOGIN = 'https://accounts.woozooo.com/accounts.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function challenge(html) {
  const arg = html.match(/arg1\s*=\s*['"]([a-f0-9]{40})['"]/i)?.[1];
  if (!arg) return null;
  const order = [15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36];
  const reordered = order.map(n => arg[n - 1]).join('');
  const key = '3000176000856006061501533003690027800375';
  return Array.from({length:20}, (_,i) => (parseInt(reordered.slice(i*2,i*2+2),16) ^ parseInt(key.slice(i*2,i*2+2),16)).toString(16).padStart(2,'0')).join('');
}
function trustedUrl(value, base = BASE) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(url.hostname === 'woozooo.com' || url.hostname.endsWith('.woozooo.com'))) {
    throw Error(`蓝奏云返回了不受信任的登录跳转域名：${url.hostname}`);
  }
  return url.href;
}
function shareUrl(info) {
  if(String(info.onof)==='1' && !info.pwd)throw Error('分享链接开启了密码，但蓝奏云未返回提取密码');
  const raw = info.is_newd && info.f_id ? `${info.is_newd.replace(/\/$/, '')}/${info.f_id}` : info.new_url;
  if (!raw) throw Error('蓝奏云未返回分享链接');
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('分享链接必须使用 HTTPS');
  return { url: url.href, password: String(info.onof) === '1' ? String(info.pwd || '') : '' };
}
class Lanzou {
  constructor(fetcher = fetch) { this.fetch = fetcher; this.cookies = new Map(); }
  async request(url, options = {}, attempt = 0) {
    url = trustedUrl(url);
    let response;
    try {
      response = await this.fetch(url, { ...options, redirect:'manual', signal:AbortSignal.timeout(options.body instanceof Readable ? 600000 : 30000),
        headers: { 'user-agent':UA, 'accept-language':'zh-CN,zh;q=0.9', referer:BASE+'/mydisk.php',
          cookie:[...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...options.headers } });
    } catch { throw Error('蓝奏云网络请求失败或超时，请重试'); }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0,at).trim(), pair.slice(at+1));
    }
    if (response.status >= 300 && response.status < 400) {
      return { body:'', location:trustedUrl(response.headers.get('location'),url) };
    }
    if (!response.ok) throw Error(`蓝奏云请求失败（HTTP ${response.status}）`);
    const body = await response.text();
    const acw = challenge(body);
    if (acw && attempt === 0 && !options.body) { this.cookies.set('acw_sc__v2',acw); return this.request(url,options,1); }
    return { body };
  }
  async json(url, form) {
    const {body} = await this.request(url, {method:'POST', body:new URLSearchParams(form)});
    let data;
    try { data = JSON.parse(body.replace(/^\uFEFF/, '')); }
    catch { throw Error('蓝奏云返回了非 JSON 响应，可能需要在网页登录验证后配置 LANZOU_COOKIE'); }
    if (![1,2].includes(Number(data.zt))) {
      // Never include raw responses: login redirects and account data can contain secrets.
      if(typeof data.info==='string' && data.info.includes('仅会员'))throw Error('蓝奏云账号需要会员才能关闭提取密码；发布清单未更新');
      throw Error(Number(data.zt) === 9 ? '蓝奏云登录已失效' : '蓝奏云拒绝操作，请检查账号、文件类型、大小限制或网页登录验证');
    }
    return data;
  }
  async login({username,password,cookie}) {
    if (cookie) {
      for (const pair of cookie.split(';')) { const at=pair.indexOf('='); if(at>0)this.cookies.set(pair.slice(0,at).trim(),pair.slice(at+1).trim()); }
    } else {
      if (!username || !password) throw Error('请配置 LANZOU_USERNAME 和 LANZOU_PASSWORD，或 LANZOU_COOKIE');
      await this.request(LOGIN+'?action=login&ref=up.woozooo.com');
      const data = await this.json(LOGIN,{task:'uselogin',username,password,ref:'up.woozooo.com'});
      let next = data.msgs;
      for (let hops=0; next && hops<10; hops++) {
        const url = trustedUrl(next,LOGIN);
        const {body,location} = await this.request(url);
        if (new URL(url).pathname === '/mydisk.php' && !location) break;
        next = location || body.match(/(?:document\.location\.href|location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i)?.[1] || body.match(/<iframe[^>]*src=['"]([^'"]+)['"]/i)?.[1];
        if(next)next=trustedUrl(next,url);
      }
    }
    await this.listFiles(-1); // Verify authenticated API access, including Cookie logins.
    const {body} = await this.request(BASE+'/mydisk.php?item=profile&action=mypower');
    const limit = body.match(/单个文件大小:\s*<\/div>\s*<div class="mf2">\s*<font[^>]*>([\d.]+)\s*([KMGT]?)\s*<\/font>/i);
    this.maxBytes = limit ? Number(limit[1]) * 1024 ** ({K:1,M:2,G:3,T:4}[limit[2].toUpperCase()] || 2) : 100*1024*1024;
    return { maxBytes:this.maxBytes };
  }
  api(form) { return this.json(BASE+'/doupload.php',form); }
  async listFiles(folderId) {
    const files=[];
    for(let pg=1; pg<=1000; pg++) {
      const data=await this.api({task:'5',folder_id:String(folderId),pg:String(pg),vei:''});
      const items=Array.isArray(data.text)?data.text:[];
      files.push(...items);
      if(items.length<18)return files;
    }
    throw Error('文件列表分页过多');
  }
  async releaseFolder(configuredId) {
    if(configuredId) { if(!/^-?\d+$/.test(configuredId))throw Error('LANZOU_FOLDER_ID 无效'); return configuredId; }
    return '-1'; // Publish directly in the account root.
  }
  async detail(id) { return shareUrl((await this.api({task:'22',file_id:String(id)})).info || {}); }
  async publicFile(id) {
    const current=await this.detail(id);if(!current.password)return current;
    await this.api({task:'23',file_id:String(id),shows:'0',shownames:''});
    const detail=await this.detail(id);
    if(detail.password)throw Error('蓝奏云仍要求提取密码，发布已中止');
    return detail;
  }
  async upload(file, name, folderId) {
    const size=fs.statSync(file).size;
    if(size>this.maxBytes)throw Error('安装包超过账号单文件限制，请压缩安装包或升级蓝奏云容量；不会生成普通用户无法合并的分片');
    const boundary='----XgoatCast'+crypto.randomBytes(16).toString('hex');
    const fields={task:'1',vie:'2',ve:'2',id:'WU_FILE_0',folder_id_bb_n:String(folderId),size:String(size),name};
    let head=Object.entries(fields).map(([k,v])=>`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
    head+=`--${boundary}\r\nContent-Disposition: form-data; name="upload_file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail=`\r\n--${boundary}--\r\n`;
    const body=Readable.from((async function*(){yield Buffer.from(head); yield* fs.createReadStream(file); yield Buffer.from(tail);})());
    const {body:result}=await this.request(BASE+'/html5up.php',{method:'POST',body,duplex:'half',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(Buffer.byteLength(head)+size+Buffer.byteLength(tail))}});
    let data;try{data=JSON.parse(result);}catch{throw Error('上传未返回有效 JSON；发布清单未更新');}
    if(Number(data.zt)!==1)throw Error('蓝奏云上传失败；发布清单未更新');
    // Uploads are never blindly retried: a lost response may already have stored the file.
  }
}
module.exports={Lanzou,challenge,trustedUrl,shareUrl};
