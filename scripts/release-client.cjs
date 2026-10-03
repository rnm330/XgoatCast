#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseEnv, parseArgs } = require('node:util');
const { Lanzou } = require('./lanzou.cjs');
const root = path.resolve(__dirname, '..');

function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(value || '');
  if (!match || (match[4] || '').split('.').some(x => /^\d+$/.test(x) && x.length>1 && x[0]==='0')) throw Error('版本号必须符合 SemVer，例如 0.0.1-beta.2');
  return { core:match.slice(1,4).map(BigInt), pre:match[4]?.split('.') || [] };
}
function compareVersions(a,b) {
  a=versionParts(a);b=versionParts(b);
  for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return a.core[i]>b.core[i]?1:-1;
  if(!a.pre.length || !b.pre.length)return a.pre.length===b.pre.length?0:a.pre.length?-1:1;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    const x=a.pre[i],y=b.pre[i];if(x===y)continue;if(x===undefined)return -1;if(y===undefined)return 1;
    const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);
    if(xn&&yn)return BigInt(x)>BigInt(y)?1:-1;
    if(xn!==yn)return xn?-1:1;return x>y?1:-1;
  }
  return 0;
}
function writeJson(file,value,exclusive=false) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const body=JSON.stringify(value,null,2)+'\n';
  if(exclusive) { fs.writeFileSync(file,body,{flag:'wx'}); return; }
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,body);fs.renameSync(temporary,file);
}
function publishManifests(directory,manifest,exclusive=false) {
  writeJson(path.join(directory,'releases',manifest.version+'.json'),manifest,exclusive);
  const releases=fs.readdirSync(path.join(directory,'releases')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,'releases',name),'utf8')));
  releases.sort((a,b)=>compareVersions(b.version,a.version));
  writeJson(path.join(directory,'history.json'),{schemaVersion:1,product:'XgoatCast',releases:releases.map(({version,channel,publishedAt,notes})=>({version,channel,publishedAt,notes}))});
  writeJson(path.join(directory,'latest.json'),manifest);
}
async function sha256(file) {
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
function acquireLock(state,version) {
  fs.mkdirSync(state,{recursive:true});
  const file=path.join(state,'publish.lock');
  let lock;try{lock=fs.openSync(file,'wx');}catch{throw Error('另一个发布任务正在运行，或有中断任务遗留的 .release-state/publish.lock；确认后再移除锁');}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,version,at:new Date().toISOString()}));
  return () => { fs.closeSync(lock);fs.unlinkSync(file); };
}
function loadEnv(envFile,provider='rainyun') {
  const filename=provider==='lanzou'?'lanzou':'release';
  const local=path.join(root,'.env.'+filename);
  const fallback=path.join(os.homedir(),'.config','xgoatcast',filename+'.env');
  const file=envFile || (fs.existsSync(local)?local:fallback);
  if(envFile && !fs.existsSync(file))throw Error('指定的凭据文件不存在');
  return { ...(fs.existsSync(file)?parseEnv(fs.readFileSync(file,'utf8')):{}), ...process.env };
}
async function publish(options, env, client) {
  const provider=options.provider || env.CLIENT_RELEASE_PROVIDER || 'rainyun';
  if(!['rainyun','lanzou'].includes(provider))throw Error('发布提供商必须为 rainyun 或 lanzou');
  if(!client&&provider==='lanzou')client=new Lanzou();
  const storage=()=>client || new (require('./rainyun-storage.cjs').RainyunStorage)(env);
  const directory=options.releaseDir || path.join(root,'web/public/downloads/windows');
  const state=options.stateDir || path.join(root,'.release-state');
  if(options.checkLogin&&provider==='rainyun')return storage().checkLogin();
  if(options.checkLogin) { const result=await client.login({username:env.LANZOU_USERNAME,password:env.LANZOU_PASSWORD,cookie:env.LANZOU_COOKIE});return { loginVerified:true,...result }; }
  const version=options.version || fs.readFileSync(path.join(root,'desktop/native-client/version.h'),'utf8').match(/AppVersion\[\]\s*=\s*"([^"]+)"/)?.[1];
  versionParts(version);
  if(options.kind && options.kind!=='installer')throw Error('客户端仅发布安装包');
  const file=path.resolve(options.file || path.join(root,'desktop/native-client/out',`XgoatCast-${version}-win-x64-setup.exe`));
  const name=path.basename(file);
  if(!/^[A-Za-z0-9._-]+$/.test(name))throw Error('发布包文件名只能包含字母、数字、点、下划线和短横线');
  if(name!==`XgoatCast-${version}-win-x64-setup.exe`)throw Error('发布包必须为包含版本号的 win-x64-setup.exe 安装包');
  if(!fs.statSync(file).isFile() || fs.statSync(file).size===0)throw Error('发布包为空或不是文件');
  const notes=options.notesFile?fs.readFileSync(options.notesFile,'utf8').trim():options.notes?.trim();
  if(!notes)throw Error('请使用 --notes-file 或 --notes 提供本次更新说明');
  const latestFile=path.join(directory,'latest.json'),historyFile=path.join(directory,'releases',version+'.json');
  const previous=fs.existsSync(latestFile)?JSON.parse(fs.readFileSync(latestFile,'utf8')):null;
  if(previous && compareVersions(version,previous.version)<0)throw Error('版本号低于当前发布版本，拒绝回退');
  const checksum=await sha256(file);
  const existing=fs.existsSync(historyFile)?JSON.parse(fs.readFileSync(historyFile,'utf8')):null;
  if(existing) {
    if(existing.sha256!==checksum || existing.fileName!==name)throw Error('这个版本已发布不同的包，请递增版本号；不会覆盖历史版本');
    if(existing.notes!==notes)throw Error('这个版本的更新说明已固定，请使用新的版本号');
    if(!options.dryRun) {
      const unlock=acquireLock(state,version);
      try {
        const current=fs.existsSync(latestFile)?JSON.parse(fs.readFileSync(latestFile,'utf8')):null;
        if(current && compareVersions(version,current.version)<0)throw Error('发布清单已变化，拒绝回退');
        if(provider==='rainyun') {
          const uploaded=await storage().publishFile({file,version,name,checksum});
          existing.downloadUrl=uploaded.downloadUrl;existing.provider=provider;
          writeJson(path.join(state,version+'.rainyun.json'),{...uploaded,status:'uploaded',fileName:name});
        }else{
          const receiptFile=path.join(state,version+'.json');
          if(!fs.existsSync(receiptFile))throw Error('缺少上传记录，无法验证免密码公开下载');
          const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
          if(!receipt.fileId || receipt.sha256!==checksum)throw Error('上传记录不匹配');
          await client.login({username:env.LANZOU_USERNAME,password:env.LANZOU_PASSWORD,cookie:env.LANZOU_COOKIE});
          const detail=await client.publicFile(receipt.fileId);
          const url=new URL(detail.url);if(url.protocol!=='https:')throw Error('下载链接必须使用 HTTPS');
          existing.downloadUrl=url.href;existing.packageType='installer';delete existing.downloadPassword;
        }
        existing.packageType='installer';delete existing.downloadPassword;
        publishManifests(directory,existing);
      } finally { unlock(); }
    }
    return { ...existing, reused:true, dryRun:!!options.dryRun };
  }
  // A placeholder manifest may be completed for the first release; real same-version releases stay immutable.
  if(previous && compareVersions(version,previous.version)===0 && previous.sha256)throw Error('当前版本已发布，请递增版本号');
  const base=new URL(options.site || 'https://cast.xgoat.top');
  if(base.protocol!=='https:' || base.username || base.password || base.pathname!=='/' || base.search || base.hash)throw Error('--site 必须为 HTTPS 网站根地址');
  if(options.dryRun)return {dryRun:true,version,fileName:name,sha256:checksum,bytes:fs.statSync(file).size,releasePageUrl:new URL('/downloads.html',base).href};
  const unlock=acquireLock(state,version);
  try {
    // Recheck after taking the lock, before any upload or manifest mutation.
    if(fs.existsSync(historyFile))throw Error('版本刚被另一个任务发布，请重试以验证相同包');
    const current=fs.existsSync(latestFile)?JSON.parse(fs.readFileSync(latestFile,'utf8')):null;
    if(current && (compareVersions(version,current.version)<0 || (compareVersions(version,current.version)===0 && current.sha256)))throw Error('发布清单已变化，请检查当前版本');
    let uploaded;
    if(provider==='rainyun'){
      uploaded=await storage().publishFile({file,version,name,checksum});
      writeJson(path.join(state,version+'.rainyun.json'),{...uploaded,status:'uploaded',fileName:name});
    }else{
      await client.login({username:env.LANZOU_USERNAME,password:env.LANZOU_PASSWORD,cookie:env.LANZOU_COOKIE});
      const folderId=await client.releaseFolder(env.LANZOU_FOLDER_ID);
      const receiptFile=path.join(state,version+'.json');
      const receipt=fs.existsSync(receiptFile)?JSON.parse(fs.readFileSync(receiptFile,'utf8')):null;
      let files=await client.listFiles(folderId),found=files.find(f=>f.name_all===name);
      if(found && (!receipt || receipt.sha256!==checksum || receipt.fileName!==name || String(receipt.folderId)!==String(folderId)))throw Error('蓝奏云已有同名包，但没有匹配的本地上传记录；请核对后使用新的版本号');
      if(!found) {
        // Write intent before upload: if the response is lost, retry can reconcile by unique name/hash intent.
        writeJson(receiptFile,{fileName:name,sha256:checksum,folderId,status:'uploading'});
        await client.upload(file,name,folderId);
        for(let attempt=0;attempt<5 && !found;attempt++) {
          files=await client.listFiles(folderId);found=files.find(f=>f.name_all===name);
          if(!found)await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }
      if(!found)throw Error('上传完成，但尚未找到文件，保留原清单；稍后重跑同一命令');
      const detail=await client.publicFile(found.id);
      uploaded={provider:'lanzou',downloadUrl:detail.url};
      writeJson(receiptFile,{fileName:name,sha256:checksum,folderId,fileId:found.id,status:'uploaded',downloadUrl:detail.url});
    }
    const url=new URL(uploaded.downloadUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('下载链接必须使用 HTTPS');
    const manifest={schemaVersion:1,product:'XgoatCast',channel:version.includes('-')?'beta':'stable',version,
      publishedAt:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),
      downloadUrl:url.href,releasePageUrl:new URL('/downloads.html',base).href,sha256:checksum,
      notes,provider,fileName:name,bytes:fs.statSync(file).size,packageType:'installer'};
    // Keep the old latest manifest until upload, listing and share-link retrieval all succeed.
    publishManifests(directory,manifest,true);
    return manifest;
  } finally { unlock(); }
}
async function main() {
  const {values}=parseArgs({options:{provider:{type:'string'},file:{type:'string'},version:{type:'string'},notes:{type:'string'},'notes-file':{type:'string'},site:{type:'string'},'env-file':{type:'string'},'dry-run':{type:'boolean'},'check-login':{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('npm run release:client -- --file <setup.exe> --notes-file <notes.txt> [--version <SemVer>] [--dry-run]\n--check-login 仅验证账号；--env-file 指定私密配置。\n只发布安装包，默认上传雨云对象存储，生成免密码下载链接和历史日志；部署网站后对外生效。\n--provider rainyun|lanzou 选择上传服务。');return;}
  const result=await publish({provider:values.provider,file:values.file,version:values.version,notes:values.notes,notesFile:values['notes-file'],site:values.site,dryRun:values['dry-run'],checkLogin:values['check-login']},loadEnv(values['env-file'],values.provider));
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={publish,compareVersions,versionParts,loadEnv};
