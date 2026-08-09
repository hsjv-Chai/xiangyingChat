'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { scanFolder } = require('./parser');

const SMOKE = process.env.SMOKE_TEST === '1';
const RENDERER_ROOT = path.join(__dirname, 'renderer');

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

/* ---------------- 路径与协议 ---------------- */

function isInside(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname);
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
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '聊天记录阅读器',
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('renderer://app/index.html');
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

               return JSON.stringify({
                 convs,
                 msgs,
                 imgs: imgs.length,
                 imgLoaded,
                 firstTitle,
                 pickedAudio,
                 audioCount,
                 pickedSingle,
                 singleMsgs,
                 singleSenders,
                 meRows,
                 filteredConvs,
                 quoteCards,
                 marks,
                 currentMark,
                 lightboxShown,
               });
             })()`
          )
          .then((result) => {
            console.log('SMOKE_UI_STATE', result);
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
    }, 12000);
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
