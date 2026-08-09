import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(appPath, 'Contents', 'Info.plist');
const resourcesDir = path.join(appPath, 'Contents', 'Resources');
const iconSrc = path.join(root, 'src', 'assets', 'icon.icns');
const iconDest = path.join(resourcesDir, 'icon.icns');
const electronIconDest = path.join(resourcesDir, 'electron.icns');
const NAME = '响应消息';

if (!existsSync(plist)) {
  console.warn('未找到 Electron.app，请先执行 npm install');
  process.exit(0);
}

let current = '';
try {
  current = execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', plist], { encoding: 'utf8' }).trim();
} catch {
  current = '';
}

let changed = false;

if (existsSync(iconSrc)) {
  const iconChanged =
    !existsSync(iconDest) ||
    !existsSync(electronIconDest) ||
    !readFileSync(iconSrc).equals(readFileSync(iconDest)) ||
    !readFileSync(iconSrc).equals(readFileSync(electronIconDest));
  if (iconChanged) {
    copyFileSync(iconSrc, iconDest);
    copyFileSync(iconSrc, electronIconDest); // 覆盖原始 electron.icns，防止回退路径读到旧图标
    execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', 'icon.icns', plist]);
    changed = true;
  }
}

if (current !== NAME) {
  execFileSync('plutil', ['-replace', 'CFBundleName', '-string', NAME, plist]);
  execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', NAME, plist]);
  changed = true;
}

if (!changed) {
  console.log(`Dock 名称「${NAME}」与图标均已就绪`);
  process.exit(0);
}

execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
console.log(`Dock 名称已更新为「${NAME}」并重新签名`);
