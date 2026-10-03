const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'renderer/app.js')], bundle: true, outfile: path.join(root, 'renderer/bundle.js'), platform: 'browser', minify: true });
const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/r:System.Web.Extensions.dll', '/r:System.Management.dll', '/r:System.Windows.Forms.dll'];
if (process.platform === 'win32') {
  execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [...args, '/out:' + path.join(root, 'native/AudioBridge.exe'), path.join(root, 'native/AudioBridge.cs')], { stdio: 'inherit' });
} else {
  const win = p => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
  execFileSync('/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', [...args, '/out:' + win(path.join(root, 'native/AudioBridge.exe')), win(path.join(root, 'native/AudioBridge.cs'))], { stdio: 'inherit' });
}
console.log('Built renderer and Windows audio helper.');
