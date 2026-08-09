'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  protocol,
  net,
} = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { PNG } = require('pngjs');
const { scanFolder } = require('./parser');

const SMOKE = process.env.SMOKE_TEST === '1';
const RENDERER_ROOT = path.join(__dirname, 'renderer');
const APP_ICON = path.join(__dirname, 'assets', 'icon-512.png');
const EXPORT_WIDTH = 760; // 导出图片内容宽度（CSS px）
const EXPORT_SLICE = 800; // 分片截图的目标视口高度（会被屏幕高度钳制，代码自适应）

let mainWindow = null;
let folderRoot = null;
let cache = new Map(); // 绝对路径 -> 规范化消息数组（新消息在前）
let settings = { folder: null, me: '' };

/* ---------------- 设置持久化 ---------------- */

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    settings = {
      folder: typeof raw.folder === 'string' ? raw.folder : null,
      me: typeof raw.me === 'string' ? raw.me : '',
    };
  } catch {
    settings = { folder: null, me: '' };
  }
  return settings;
}

function persistSettings() {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------- 导出图片 ---------------- */

async function waitForExportReady(win, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const info = await win.webContents
      .executeJavaScript(
        'window.__exportReady ? { ready: true, width: window.__exportWidth, height: window.__exportHeight } : { ready: false }'
      )
      .catch(() => ({ ready: false }));
    if (info && info.ready) return info;
    await sleep(120);
  }
  throw new Error('导出页面渲染超时');
}

/**
 * 分片滚动截图并拼接为一张完整 PNG。
 * 窗口高度会被 macOS 钳制到屏幕高度，因此按实际视口高度滚动、逐片截取，
 * 再用 pngjs 按每片实际像素高度拼合；超长会话自动降为 1x 尺寸控制体积。
 */
async function captureFullPage(win, naturalHeight) {
  win.setContentSize(EXPORT_WIDTH, Math.min(EXPORT_SLICE, naturalHeight));
  win.setPosition(-10000, -10000);
  win.showInactive();
  await sleep(400);

  const factor = naturalHeight > 13000 ? 2 : 1; // 2 = 截 2x 后缩小为 1x
  const targetWidth = factor === 2 ? EXPORT_WIDTH : EXPORT_WIDTH * 2;
  const sliceBuffers = [];
  let y = 0;
  let totalHeight = 0;

  while (y < naturalHeight) {
    if (y > 0) {
      await win.webContents.executeJavaScript(`window.scrollTo(0, ${y})`);
      await sleep(150);
    }
    const shot = await win.webContents.capturePage();
    if (shot.isEmpty()) throw new Error('截图失败');

    const h = shot.getSize().height;
    if (factor === 2) {
      const resized = shot.resize({ width: targetWidth, height: Math.round(h / 2) });
      sliceBuffers.push(resized.toPNG());
      totalHeight += Math.round(h / 2);
    } else {
      sliceBuffers.push(shot.toPNG());
      totalHeight += h;
    }

    const viewportH = await win.webContents
      .executeJavaScript('window.innerHeight')
      .catch(() => EXPORT_SLICE);
    if (SMOKE) console.log('EXPORT_SLICE', 'y=' + y, 'viewport=' + viewportH, 'capturedH=' + h);
    y += Math.max(1, Math.floor(viewportH));
  }

  const finalPng = new PNG({ width: targetWidth, height: totalHeight });
  let rowOffset = 0;
  for (const buffer of sliceBuffers) {
    const slice = PNG.sync.read(buffer);
    for (let row = 0; row < slice.height; row++) {
      const srcStart = row * slice.width * 4;
      slice.data.copy(finalPng.data, (rowOffset + row) * targetWidth * 4, srcStart, srcStart + targetWidth * 4);
    }
    rowOffset += slice.height;
  }
  return PNG.sync.write(finalPng);
}

/* ---------------- 图片保存 / 复制 / 右键菜单 ---------------- */

function imageDefaultName(src) {
  try {
    const u = new URL(src);
    const name = decodeURIComponent(u.pathname.split('/').pop() || '');
    return name || '图片.png';
  } catch {
    return '图片.png';
  }
}

/** 把 localimg:// 或 http(s):// 的图片解析为本地文件路径或内存 Buffer。 */
async function resolveImageSource(src) {
  if (typeof src !== 'string') return { error: '不支持的图片来源' };
  if (src.startsWith('localimg://')) {
    let filePath;
    try {
      filePath = decodeLocalimgPath(src);
    } catch {
      return { error: '图片地址无效' };
    }
    if (!folderRoot || !isInside(filePath, folderRoot)) return { error: '图片不在当前文件夹内' };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { error: '图片文件不存在' };
    return { localPath: filePath };
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const response = await net.fetch(src);
      if (!response.ok) return { error: '网络图片下载失败（' + response.status + '）' };
      return { buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (err) {
      return { error: '网络图片下载失败：' + err.message };
    }
  }
  return { error: '不支持的图片来源' };
}

async function saveImageFromSrc(src) {
  try {
    const resolved = await resolveImageSource(src);
    if (resolved.error) return { error: resolved.error };

    let filePath;
    if (SMOKE) {
      filePath = process.env.SMOKE_SAVE_IMAGE || path.join(app.getPath('temp'), 'smoke-image-' + Date.now() + '.png');
    } else {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出图片',
        defaultPath: imageDefaultName(src),
        buttonLabel: '导出',
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = result.filePath;
    }

    if (resolved.localPath) fs.copyFileSync(resolved.localPath, filePath);
    else fs.writeFileSync(filePath, resolved.buffer);
    return { saved: true, path: filePath };
  } catch (err) {
    console.error('保存图片失败:', err);
    return { error: '保存图片失败：' + err.message };
  }
}

async function copyImageFromSrc(src) {
  const resolved = await resolveImageSource(src);
  if (resolved.error) return resolved;
  try {
    if (resolved.localPath) clipboard.writeImage(nativeImage.createFromPath(resolved.localPath));
    else clipboard.writeImage(nativeImage.createFromBuffer(resolved.buffer));
    return { copied: true };
  } catch (err) {
    return { error: '复制图片失败：' + err.message };
  }
}

function notifyRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('image-export-result', payload);
  }
}

function registerContextMenu() {
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];
    const isImage = params.mediaType === 'image' && /^(localimg:|https?:)/i.test(params.srcURL || '');
    const isLink = /^https?:\/\//i.test(params.linkURL || '');
    const hasText = params.selectionText && params.selectionText.trim().length > 0;

    if (isImage) {
      template.push({
        label: '导出图片…',
        click: async () => {
          const result = await saveImageFromSrc(params.srcURL);
          notifyRenderer(result);
        },
      });
      template.push({
        label: '复制图片',
        click: async () => {
          const result = await copyImageFromSrc(params.srcURL);
          notifyRenderer(result);
        },
      });
    }

    if (isLink) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '打开链接', click: () => shell.openExternal(params.linkURL) });
      template.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) });
    }

    if (hasText) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '复制', role: 'copy' });
      template.push({ label: '全选', role: 'selectAll' });
    } else if (!template.length) {
      template.push({ label: '全选', role: 'selectAll' });
    }

    if (template.length) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });
}

async function exportConversationImage(title, msgIds) {
  let exportWin = null;
  try {
    if (typeof title !== 'string' || !title) return { error: '请先选择一个会话' };
    if (!Array.isArray(msgIds) || msgIds.length === 0) {
      return { error: '请先选择要导出的消息' };
    }

    let messages = null;
    for (const [filePath, msgs] of cache.entries()) {
      if (path.basename(filePath, path.extname(filePath)) === title) {
        messages = msgs;
        break;
      }
    }
    if (!messages) return { error: '未找到该会话' };

    const idSet = new Set(msgIds.map((id) => String(id)));
    const selected = messages.filter((m) => idSet.has(String(m.msgId)));
    if (selected.length === 0) return { error: '没有匹配的选中消息' };

    exportWin = new BrowserWindow({
      width: 800,
      height: 800,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const url =
      'renderer://app/export.html?title=' +
      encodeURIComponent(title) +
      '&me=' +
      encodeURIComponent(settings.me || '') +
      '&ids=' +
      encodeURIComponent(selected.map((m) => String(m.msgId)).join(','));
    await exportWin.loadURL(url);

    const info = await waitForExportReady(exportWin);
    const pngBuffer = await captureFullPage(exportWin, info.height);

    let filePath;
    if (SMOKE) {
      filePath = process.env.SMOKE_EXPORT || path.join(app.getPath('temp'), 'smoke-export-' + Date.now() + '.png');
    } else {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出会话图片',
        defaultPath: `${title}.png`,
        buttonLabel: '导出',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = result.filePath;
    }

    fs.writeFileSync(filePath, pngBuffer);
    return { saved: true, path: filePath };
  } catch (err) {
    console.error('导出失败:', err);
    return { error: '导出失败：' + err.message };
  } finally {
    if (exportWin && !exportWin.isDestroyed()) exportWin.destroy();
  }
}

/* ---------------- 路径与协议 ---------------- */

function isInside(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 从 localimg:// URL 还原绝对路径（兼容 Windows 盘符路径）。 */
function decodeLocalimgPath(url) {
  let filePath = decodeURIComponent(new URL(url).pathname);
  if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  return filePath;
}

function registerProtocols() {
  protocol.handle('renderer', (request) => {
    try {
      const url = new URL(request.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      const filePath = path.normalize(path.join(RENDERER_ROOT, p));
      if (!filePath.startsWith(RENDERER_ROOT + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });

  protocol.handle('localimg', (request) => {
    try {
      const filePath = decodeLocalimgPath(request.url);
      const inside = !!folderRoot && isInside(filePath, folderRoot);
      if (SMOKE) console.log('LOCALIMG_REQ', request.url, '=>', filePath, 'inside=', inside);
      if (!inside) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle('init', () => {
    loadSettings();
    const smokeFolder = SMOKE && process.env.SMOKE_FOLDER;
    const folder =
      smokeFolder ||
      (settings.folder && fs.existsSync(settings.folder) ? settings.folder : null);
    if (folder) {
      const scan = scanFolder(folder, cache);
      folderRoot = folder;
      return {
        settings: { ...settings, folder },
        conversations: scan.summaries,
        errors: scan.errors,
      };
    }
    return { settings, conversations: null, errors: [] };
  });

  ipcMain.handle('select-folder', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择聊天记录导出文件夹',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const folder = result.filePaths[0];
    const scan = scanFolder(folder, cache);
    folderRoot = folder;
    settings.folder = folder;
    persistSettings();
    return { canceled: false, folder, conversations: scan.summaries, errors: scan.errors };
  });

  ipcMain.handle('load-conversation', (_event, title) => {
    for (const [filePath, messages] of cache.entries()) {
      if (path.basename(filePath, path.extname(filePath)) === title) {
        return { title, messages };
      }
    }
    return { error: '未找到该会话' };
  });

  ipcMain.handle('get-settings', () => loadSettings());

  ipcMain.handle('save-settings', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.folder === 'string') settings.folder = patch.folder;
      if (typeof patch.me === 'string') settings.me = patch.me;
    }
    if (!SMOKE) persistSettings();
    return settings;
  });

  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('export-image', (_event, title, msgIds) => exportConversationImage(title, msgIds));

  ipcMain.handle('save-image', (_event, src) => saveImageFromSrc(src));

  ipcMain.handle('get-audio', async (_event, payload) => {
    try {
      if (SMOKE) {
        // 冒烟测试使用内置测试语音，避免依赖网络
        const fixture = path.join(__dirname, 'assets', 'voice-test.amr');
        if (fs.existsSync(fixture)) {
          const buf = fs.readFileSync(fixture);
          return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        }
      }

      const serverpath = payload && typeof payload.serverpath === 'string' ? payload.serverpath : '';
      const localpath = payload && typeof payload.localpath === 'string' ? payload.localpath : '';
      if (!serverpath && !localpath) return { error: '没有可用的语音文件' };

      const cacheDir = path.join(app.getPath('userData'), 'audio-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const hash = crypto.createHash('sha1').update(serverpath || localpath).digest('hex');
      const cacheFile = path.join(cacheDir, hash + '.amr');

      if (fs.existsSync(cacheFile)) {
        const buf = fs.readFileSync(cacheFile);
        return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      }

      let data = null;
      if (localpath) {
        try {
          if (fs.existsSync(localpath) && fs.statSync(localpath).isFile()) data = fs.readFileSync(localpath);
        } catch {
          /* 本地路径不可读时忽略 */
        }
      }
      if (!data && /^https?:\/\//i.test(serverpath)) {
        const response = await net.fetch(serverpath);
        if (!response.ok) return { error: '语音下载失败（' + response.status + '）' };
        data = Buffer.from(await response.arrayBuffer());
      }
      if (!data) return { error: '没有可用的语音文件' };

      fs.writeFileSync(cacheFile, data);
      return { buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    } catch (err) {
      console.error('获取语音失败:', err);
      return { error: '语音获取失败：' + err.message };
    }
  });
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '响应消息',
    icon: APP_ICON,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 8, y: 16 },
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('renderer://app/index.html');
  registerContextMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (SMOKE) {
    mainWindow.webContents.on('did-finish-load', () => console.log('SMOKE_RENDERER_LOADED'));
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => console.log('SMOKE_FAIL_LOAD', code, desc));
    mainWindow.webContents.on('console-message', (event, ...rest) => {
      console.log('SMOKE_RENDERER_CONSOLE', rest.join(' '), event && event.message ? `| ${event.message}` : '');
    });
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        mainWindow.webContents
          .executeJavaScript(
            `(async () => {
               const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
               const pick = (title) => {
                 const item = Array.from(document.querySelectorAll('#convList .conv-item'))
                   .find((el) => el.querySelector('.conv-name').textContent === title);
                 if (item) item.click();
                 return !!item;
               };
               const convs = document.querySelectorAll('#convList .conv-item').length;
               const msgs = document.querySelectorAll('#messages .msg-row').length;
               const imgs = Array.from(document.querySelectorAll('#messages .msg-img'));
               const imgLoaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
               const firstTitle = document.querySelector('#chatTitle').textContent;

               // 先清空“我”设置，保证断言确定性（SMOKE 模式下不会写入磁盘）
               document.querySelector('#settingsMe').value = '';
               document.querySelector('#settingsSave').click();
               await sleep(300);

               const pickedAudio = pick('23通用选考群');
               await sleep(600);
               const audioCount = document.querySelectorAll('#messages .audio-bubble').length;
               const audioBubbles = Array.from(document.querySelectorAll('#messages .audio-bubble'));
               if (audioBubbles[0]) audioBubbles[0].click();
               let audioPlaying = false;
               for (let i = 0; i < 40; i++) {
                 await sleep(50);
                 if (document.querySelector('#messages .audio-bubble.playing')) {
                   audioPlaying = true;
                   break;
                 }
               }
               const playingProgress = document.querySelector('#messages .audio-bubble.playing .audio-progress');
               const audioProgressText = playingProgress ? playingProgress.textContent : '';
               const pauseTarget = document.querySelector('#messages .audio-bubble.playing');
               if (pauseTarget) pauseTarget.click();
               await sleep(150);
               const audioPaused = !document.querySelector('#messages .audio-bubble.playing');
               if (audioBubbles[1]) audioBubbles[1].click();
               let audioSwitched = false;
               for (let i = 0; i < 40; i++) {
                 await sleep(50);
                 const p = document.querySelector('#messages .audio-bubble.playing');
                 if (p && p !== audioBubbles[0]) {
                   audioSwitched = true;
                   break;
                 }
               }

               const pickedSingle = pick('吴亦巨');
               await sleep(600);
               const singleMsgs = document.querySelectorAll('#messages .msg-row').length;
               const singleSenders = new Set(
                 Array.from(document.querySelectorAll('#messages .msg-name')).map((n) => n.textContent)
               ).size;

               document.querySelector('#settingsMe').value = '吴亦巨';
               document.querySelector('#settingsSave').click();
               await sleep(400);
               const meRows = document.querySelectorAll('#messages .msg-row.me').length;

               // 侧栏搜索过滤
               const convSearch = document.querySelector('#convSearch');
               convSearch.value = '语文';
               convSearch.dispatchEvent(new Event('input'));
               await sleep(200);
               const filteredConvs = document.querySelectorAll('#convList .conv-item').length;

               // 回到高三15班语文，验证引用卡片
               pick('高三15班语文');
               await sleep(500);
               const quoteCards = document.querySelectorAll('#messages .quote-card').length;

               // 会话内搜索高亮 + 上一处/下一处
               document.querySelector('#chatSearchBtn').click();
               const chatSearch = document.querySelector('#chatSearch');
               chatSearch.value = '作文';
               chatSearch.dispatchEvent(new Event('input'));
               await sleep(300);
               const marks = document.querySelectorAll('#messages mark').length;
               document.querySelector('#nextBtn').click();
               await sleep(150);
               const currentMark = document.querySelectorAll('#messages mark.match-current').length;
               document.querySelector('#closeSearch').click();

               // 灯箱
               const firstImg = document.querySelector('#messages .msg-img');
               if (firstImg) firstImg.click();
               await sleep(200);
               const lightboxShown = document.querySelector('#lightbox').classList.contains('show');
               document.querySelector('#lbClose').click();

               // 勾选导出：进入选择模式（默认用小会话）
               const exportTitle = '${process.env.SMOKE_EXPORT_TITLE || '吴亦巨'}';
               // 先清空侧栏搜索，确保目标会话可见
               convSearch.value = '';
               convSearch.dispatchEvent(new Event('input'));
               await sleep(200);
               pick(exportTitle);
               await sleep(500);
               document.querySelector('#exportBtn').click();
               await sleep(300);
               const selectBarShown = document.querySelector('#selectBar').classList.contains('show');
               const checkboxCount = document.querySelectorAll('#messages .msg-check').length;
               const selRows = Array.from(document.querySelectorAll('#messages .msg-row'));
               selRows.slice(0, 3).forEach((r) => r.click());
               await sleep(150);
               const countAfter3 = document.querySelector('#selectCount').textContent;
               document.querySelector('#selectAllBtn').click();
               await sleep(150);
               const countAfterAll = document.querySelector('#selectCount').textContent;
               document.querySelector('#clearSelBtn').click();
               await sleep(150);
               const countAfterClear = document.querySelector('#selectCount').textContent;
               selRows.slice(0, 3).forEach((r) => r.click());
               document.querySelector('#exportSelBtn').click();
               let exportOk = false;
               let exportMsg = '';
               for (let i = 0; i < 900; i++) {
                 await sleep(100);
                 const t = document.querySelector('#toast').textContent;
                 if (t.includes('已导出') || t.includes('已取消') || t.includes('失败')) {
                   exportMsg = t;
                   exportOk = t.includes('已导出');
                   break;
                 }
               }
               await sleep(300);
               const selectModeExited = !document.querySelector('#selectBar').classList.contains('show');

               // 灯箱保存图片（高三15班语文第一张本地图）
               convSearch.value = '';
               convSearch.dispatchEvent(new Event('input'));
               await sleep(200);
               pick('高三15班语文');
               await sleep(500);
               const firstImg2 = document.querySelector('#messages .msg-img');
               if (firstImg2) firstImg2.click();
               await sleep(200);
               document.querySelector('#lbSave').click();
               let saveOk = false;
               let saveMsg = '';
               for (let i = 0; i < 300; i++) {
                 await sleep(100);
                 const t = document.querySelector('#toast').textContent;
                 if (t.includes('已导出') || t.includes('已保存') || t.includes('失败') || t.includes('已取消')) {
                   saveMsg = t;
                   saveOk = t.includes('已导出') || t.includes('已保存');
                   break;
                 }
               }
               document.querySelector('#lbClose').click();

               return JSON.stringify({
                 convs,
                 msgs,
                 imgs: imgs.length,
                 imgLoaded,
                 firstTitle,
                 pickedAudio,
                 audioCount,
                 audioPlaying,
                 audioProgressText,
                 audioPaused,
                 audioSwitched,
                 pickedSingle,
                 singleMsgs,
                 singleSenders,
                 meRows,
                 filteredConvs,
                 quoteCards,
                 marks,
                 currentMark,
                 lightboxShown,
                 selectBarShown,
                 checkboxCount,
                 countAfter3,
                 countAfterAll,
                 countAfterClear,
                 selectModeExited,
                 exportOk,
                 exportMsg,
                 saveOk,
                 saveMsg,
               });
             })()`
          )
          .then((result) => {
            console.log('SMOKE_UI_STATE', result);
            if (process.env.SMOKE_EXPORT && fs.existsSync(process.env.SMOKE_EXPORT)) {
              try {
                const exported = PNG.sync.read(fs.readFileSync(process.env.SMOKE_EXPORT));
                console.log('SMOKE_EXPORT_OK', exported.width, exported.height);
              } catch (err) {
                console.log('SMOKE_EXPORT_PARSE_ERROR', String(err));
              }
            }
            if (process.env.SMOKE_SAVE_IMAGE && fs.existsSync(process.env.SMOKE_SAVE_IMAGE)) {
              try {
                let srcPath = null;
                for (const [fp, msgs] of cache.entries()) {
                  if (path.basename(fp, path.extname(fp)) === '高三15班语文') {
                    // 消息数组为新在前；灯箱打开的是渲染序第一张 = 数组最后一张图片
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].image && msgs[i].image.localPath) {
                        srcPath = msgs[i].image.localPath;
                        break;
                      }
                    }
                    break;
                  }
                }
                const savedSize = fs.statSync(process.env.SMOKE_SAVE_IMAGE).size;
                const srcSize = srcPath ? fs.statSync(srcPath).size : -1;
                console.log('SMOKE_SAVE_OK', savedSize, srcSize, savedSize === srcSize);
              } catch (err) {
                console.log('SMOKE_SAVE_PARSE_ERROR', String(err));
              }
            }
            if (process.env.SMOKE_SCREENSHOT) {
              mainWindow.webContents
                .capturePage()
                .then((image) => {
                  fs.writeFileSync(process.env.SMOKE_SCREENSHOT, image.toPNG());
                  console.log('SMOKE_SCREENSHOT_SAVED');
                  console.log('SMOKE_QUIT');
                  app.quit();
                })
                .catch((err) => {
                  console.log('SMOKE_SCREENSHOT_ERROR', String(err));
                  console.log('SMOKE_QUIT');
                  app.quit();
                });
            } else {
              console.log('SMOKE_QUIT');
              app.quit();
            }
          })
          .catch((err) => {
            console.log('SMOKE_UI_ERROR', String(err));
            app.quit();
          });
      }, 2500);
    });
    setTimeout(() => {
      console.log('SMOKE_QUIT_TIMEOUT');
      app.quit();
    }, 180000);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'renderer', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'localimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  registerProtocols();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
