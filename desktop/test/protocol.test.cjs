const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLaunch } = require('../lib/protocol.cjs');
const { buildExclusions } = require('../lib/audio-policy.cjs');
const base = { server:'https://cast.example',t:'a'.repeat(64),cid:'b'.repeat(36),quality:'1080p60',lowLatency:'1',optimizationMode:'detail' };
test('launch preserves the deployment and browser identity without an account',()=>{
  const parsed = parseLaunch('xgoatcast://share?'+new URLSearchParams(base));
  assert.equal(parsed.server,base.server); assert.equal(parsed.token,base.t); assert.equal(parsed.clientId,base.cid); assert.equal(parsed.lowLatency,true);
});
test('only root HTTPS server origins or local development HTTP are accepted',()=>{
  for(const server of ['file:///C:/Windows','http://remote.example','https://name:pass@cast.example','https://cast.example/subpath']) {
    assert.throws(()=>parseLaunch('xgoatcast://share?'+new URLSearchParams({...base,server})));
  }
  assert.equal(parseLaunch('xgoatcast://share?'+new URLSearchParams({...base,server:'http://localhost:3520'})).server,'http://localhost:3520');
});
test('missing identity and unsupported quality fail before native capture',()=>{
  for(const values of [{cid:''},{t:''},{quality:'99k'}]) assert.throws(()=>parseLaunch('xgoatcast://share?'+new URLSearchParams({...base,...values})));
});
test('default presets and explicit additional software exclusions combine without duplicates',()=>{
  const names=buildExclusions(['kook','heychat'],['KOOK.exe','Teams.exe']);
  assert(names.includes('kook')); assert(names.includes('heyboxchat')); assert(names.includes('teams'));
  assert.equal(names.filter(n=>n==='kook').length,1);
  assert.deepEqual(buildExclusions([],[]),[]);
  assert.throws(()=>buildExclusions([],['C:\\bad.exe']));
});
