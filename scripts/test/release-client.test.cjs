const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {publish,compareVersions}=require('../release-client.cjs');
const {challenge,trustedUrl,shareUrl}=require('../lanzou.cjs');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xc-release-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const releaseDir=path.join(dir,'public'),stateDir=path.join(dir,'state');fs.mkdirSync(releaseDir);
  const file=path.join(dir,'XgoatCast-0.0.1-beta.2-win-x64-setup.exe');fs.writeFileSync(file,'test installer');
  const before={version:'0.0.1-beta.1',sha256:'a'.repeat(64),downloadUrl:'https://example.test/old'};
  fs.writeFileSync(path.join(releaseDir,'latest.json'),JSON.stringify(before));
  let uploads=0;const files=[];
  const client={async login(){return {maxBytes:100*1024*1024};},async releaseFolder(){return '42';},async listFiles(){return files;},async upload(){uploads++;files.push({id:'1',name_all:path.basename(file)});},async publicFile(){return {url:'https://example.lanzou.com/abc',password:''};}};
  const options={provider:'lanzou',file,version:'0.0.1-beta.2',notes:'修复共享',releaseDir,stateDir};
  return {options,client,before,dir,uploads:()=>uploads,latest:()=>JSON.parse(fs.readFileSync(path.join(releaseDir,'latest.json'),'utf8'))};
}
test('SemVer orders beta.10 after beta.2 and stable after prereleases',()=>{
  assert.equal(compareVersions('0.0.1-beta.10','0.0.1-beta.2'),1);
  assert.equal(compareVersions('0.0.1','0.0.1-beta.10'),1);
  assert.equal(compareVersions('0.0.1-beta.2','0.0.1-beta.10'),-1);
  assert.throws(()=>compareVersions('0.0.1-beta.01','0.0.1-beta.1'));
});
test('upload and share query must succeed before publishing; retries reuse uploaded file',async t=>{
  const f=fixture(t);const detail=f.client.publicFile;f.client.publicFile=async()=>{throw Error('share unavailable');};
  await assert.rejects(publish(f.options,{},f.client),/share unavailable/);
  assert.deepEqual(f.latest(),f.before);assert.equal(f.uploads(),1);
  f.client.publicFile=detail;const result=await publish(f.options,{},f.client);
  assert.equal(result.downloadPassword,undefined);assert.equal(result.releasePageUrl,'https://cast.xgoat.top/downloads.html');
  assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.equal(f.uploads(),1);
  const repeated=await publish(f.options,{},f.client);assert.equal(repeated.reused,true);assert.equal(f.uploads(),1);
  const history=JSON.parse(fs.readFileSync(path.join(f.options.releaseDir,'history.json'),'utf8'));
  assert.equal(history.releases[0].version,result.version);assert.equal(history.releases[0].downloadUrl,undefined);
});
test('a lost upload response leaves old manifest; retry reconciles the stored file',async t=>{
  const f=fixture(t),upload=f.client.upload;f.client.upload=async()=>{await upload();throw Error('response lost');};
  await assert.rejects(publish(f.options,{},f.client),/response lost/);assert.deepEqual(f.latest(),f.before);
  f.client.upload=upload;await publish(f.options,{},f.client);assert.equal(f.uploads(),1);
});
test('same version with different bytes cannot overwrite a release',async t=>{
  const f=fixture(t);await publish(f.options,{},f.client);const previous=f.latest();
  fs.writeFileSync(f.options.file,'different bytes');await assert.rejects(publish(f.options,{},f.client),/不同的包/);
  assert.deepEqual(f.latest(),previous);
});
test('dry run makes no remote calls and no manifest changes',async t=>{
  const f=fixture(t);f.client.login=async()=>{throw Error('must not log in');};
  const result=await publish({...f.options,dryRun:true},{},f.client);
  assert.equal(result.dryRun,true);assert.deepEqual(f.latest(),f.before);assert.equal(fs.existsSync(f.options.stateDir),false);
});
test('downgrades, unknown remote files and concurrent releases fail closed',async t=>{
  const f=fixture(t);await assert.rejects(publish({...f.options,version:'0.0.1-beta.0',file:f.options.file},{},f.client));
  f.client.listFiles=async()=>[{id:'existing',name_all:path.basename(f.options.file)}];
  await assert.rejects(publish(f.options,{},f.client),/没有匹配/);assert.deepEqual(f.latest(),f.before);
  fs.writeFileSync(path.join(f.options.stateDir,'publish.lock'),'held');
  await assert.rejects(publish(f.options,{},f.client),/另一个发布任务/);
});
test('auth redirects cannot leak cookies outside woozooo HTTPS hosts',()=>{
  assert.equal(trustedUrl('/acc.php','https://up.woozooo.com/mydisk.php'),'https://up.woozooo.com/acc.php');
  for(const url of ['https://evil.test','http://up.woozooo.com','https://woozooo.com.evil.test','https://user:pass@up.woozooo.com'])assert.throws(()=>trustedUrl(url));
  assert.equal(shareUrl({is_newd:'http://a.lanzou.com',f_id:'abc',onof:'1',pwd:'123'}).url,'https://a.lanzou.com/abc');
  assert.throws(()=>shareUrl({new_url:'javascript:alert(1)'}));
  assert.equal(challenge('no challenge'),null);assert.match(challenge("arg1='0123456789abcdef0123456789abcdef01234567'"),/^[a-f0-9]{40}$/);
});
