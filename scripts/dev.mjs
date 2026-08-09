import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// macOS 开发模式下需要把 Dock 名称和图标写进 Electron.app；Windows 不需要
if (platform() === 'darwin') {
  await import('./patch-dock-name.mjs');
}

const bin = path.join(root, 'node_modules', '.bin', platform() === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(bin, ['.'], { cwd: root, stdio: 'inherit', shell: platform() === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
