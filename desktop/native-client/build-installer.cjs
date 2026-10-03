// Build a versioned Inno Setup package without overwriting a published installer.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {parseArgs}=require('node:util');
const {values}=parseArgs({options:{stage:{type:'string'},compiler:{type:'string'}}});
const version=fs.readFileSync(path.join(__dirname,'version.h'),'utf8').match(/AppVersion\[\]\s*=\s*"([^"]+)"/)?.[1];
const resourceVersion=fs.readFileSync(path.join(__dirname,'app.rc'),'utf8').match(/VALUE "ProductVersion", "([^"]+)"/)?.[1];
if(!version||version!==resourceVersion)throw Error('version.h 和 app.rc 的产品版本必须一致');
const name=`XgoatCast-${version}-win-x64-setup.exe`,destination=path.join(__dirname,'out',name);
if(fs.existsSync(destination))throw Error('安装包已存在；请递增版本号，历史安装包不可覆盖');
if(!fs.existsSync(path.join(__dirname,'out/XgoatCast-win-x64/XgoatCast.exe')))throw Error('请先构建原生客户端');
const stage=values.stage?path.resolve(values.stage):__dirname;
if(process.platform!=='win32' && stage===__dirname)throw Error('WSL 下请提供 Windows 磁盘上的 --stage 目录');
if(stage!==__dirname) {
  fs.mkdirSync(path.join(stage,'installer'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'installer/XgoatCast.iss'),path.join(stage,'installer/XgoatCast.iss'));
  fs.copyFileSync(path.join(__dirname,'app.ico'),path.join(stage,'app.ico'));
  fs.cpSync(path.join(__dirname,'out/XgoatCast-win-x64'),path.join(stage,'out/XgoatCast-win-x64'),{recursive:true});
  if(fs.existsSync(path.join(stage,'out',name)))throw Error('暂存目录已有同名安装包，请使用新的暂存目录');
}
const compiler=values.compiler || process.env.INNO_SETUP_COMPILER || ['C:/Program Files (x86)/Inno Setup 6/ISCC.exe',path.join(process.env.LOCALAPPDATA||'','Programs/Inno Setup 6/ISCC.exe')].find(p=>fs.existsSync(p));
if(!compiler)throw Error('请安装 Inno Setup 6，或通过 --compiler 指定 ISCC.exe');
const windows=p=>process.platform==='win32'?p:execFileSync('wslpath',['-w',path.resolve(p)],{encoding:'utf8'}).trim();
execFileSync(compiler,['/Qp',`/DMyAppVersion=${version.split('-')[0]}`,`/DMyAppFullVersion=${version}`,windows(path.join(stage,'installer/XgoatCast.iss'))],{cwd:stage,stdio:'inherit'});
if(stage!==__dirname)fs.copyFileSync(path.join(stage,'out',name),destination,fs.constants.COPYFILE_EXCL);
console.log('Installer: '+destination);
