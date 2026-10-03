// Uses an existing MSVC developer shell or a user-supplied setup_x64.bat.
// WSL: stage on a Windows volume with --stage and invoke Windows cmd.exe.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=__dirname;
const arg=name=>process.argv.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const stage=arg('--stage')||root,setup=arg('--toolchain')||'';
const files=['main.cpp','audio.cpp','session.cpp','core.h','version.h','app.rc','app.ico','app.manifest','build.cmd'];
const dlls=['agora_rtc_sdk.dll','libaosl.dll','libagora-fdkaac.dll','libagora-ffmpeg.dll','libagora-soundtouch.dll','video_dec.dll','libagora_screen_capture_extension.dll','libagora-wgc.dll','libagora_video_encoder_extension.dll','video_enc.dll','glfw3.dll'];
function windows(p){return process.platform==='win32'?p:execFileSync('wslpath',['-w',p],{encoding:'utf8'}).trim();}
if(stage!==root){fs.mkdirSync(stage,{recursive:true});for(const f of files)fs.copyFileSync(path.join(root,f),path.join(stage,f));fs.cpSync(path.join(root,'deps'),path.join(stage,'deps'),{recursive:true,filter:p=>!p.endsWith('.zip')});}
const shell=process.platform==='win32'?'cmd.exe':'/mnt/c/Windows/System32/cmd.exe';
execFileSync(shell,['/d','/c',windows(path.join(stage,'build.cmd')),...(setup?[windows(setup)]:[])],{cwd:stage,stdio:'inherit'});
const out=path.join(root,'out','XgoatCast-win-x64');fs.mkdirSync(out,{recursive:true});
fs.copyFileSync(path.join(stage,'out','XgoatCast.exe'),path.join(out,'XgoatCast.exe'));
for(const dll of dlls)fs.copyFileSync(path.join(root,'deps','agora','sdk','x86_64',dll),path.join(out,dll));
for(const f of ['README.md','THIRD-PARTY-NOTICES.txt'])if(fs.existsSync(path.join(root,f)))fs.copyFileSync(path.join(root,f),path.join(out,f));
fs.copyFileSync(path.join(root,'deps','json-LICENSE.txt'),path.join(out,'json-LICENSE.txt'));
console.log('Native build: '+out);
