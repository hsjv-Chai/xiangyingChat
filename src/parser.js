'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TEXT_TYPES = new Set(['GROUP_TEXT', 'SINGLE_TEXT']);
const IMG_TYPES = new Set(['GROUP_IMAGE', 'SINGLE_IMAGE', 'GROUP_NOTE', 'SINGLE_NOTE']);
const AUDIO_TYPES = new Set(['GROUP_AUDIO', 'SINGLE_AUDIO']);

/**
 * 从导出 HTML 中提取 `var array = [...]` 的数组字面量文本。
 * 用逐字符扫描（带字符串/转义识别）而不是正则，避免消息正文里的 `];` 干扰。
 */
function extractArrayText(html) {
  const marker = 'var array = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('未找到消息数据');

  let i = start + marker.length;
  const len = html.length;
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;

  for (; i < len; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return html.slice(start + marker.length, i + 1);
    }
  }
  throw new Error('消息数据不完整');
}

/** 在 vm 沙箱中求值数组字面量（导出文件用单引号风格，不是严格 JSON）。 */
function parseArrayText(text) {
  const sandbox = {
    Array,
    Object,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    console,
  };
  vm.createContext(sandbox);
  const result = vm.runInContext(`(${text})`, sandbox, { timeout: 5000 });
  if (!Array.isArray(result)) throw new Error('消息数据格式不正确');
  return result;
}

function safeParse(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 在会话同名子目录中按文件名匹配本地资源（图片/音频）。 */
function resolveLocalFile(candidates, baseDir) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const name = path.basename(String(candidate).replace(/\\/g, '/'));
    if (!name || name === '/' || name === '\\') continue;
    const filePath = path.join(baseDir, name);
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch {
      /* 本地缺失，继续下一个候选 */
    }
  }
  return null;
}

function localimgUrl(absPath) {
  return 'localimg://local/' + absPath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
}

function resolveImage(content, baseDir) {
  const localPath = resolveLocalFile([content.localimg_url, content.serverimg_url], baseDir);
  const serverUrl = typeof content.serverimg_url === 'string' ? content.serverimg_url : '';
  return {
    width: Number(content.img_width) || null,
    height: Number(content.img_height) || null,
    localPath,
    serverUrl,
    src: localPath ? localimgUrl(localPath) : serverUrl,
  };
}

function normalizeMessage(raw, baseDir) {
  const type = typeof raw.type === 'string' ? raw.type : 'UNKNOWN';
  const msg = {
    msgId: raw.msgId,
    type,
    fromName: typeof raw.fromName === 'string' ? raw.fromName : '未知',
    fromId: raw.fromId,
    datetime: typeof raw.datetime === 'string' ? raw.datetime : '',
    createdTime: Number(raw.createdTime) || 0,
    quote: safeParse(raw.quote),
    content: null,
    image: null,
    audio: null,
    note: null,
  };

  if (TEXT_TYPES.has(type)) {
    msg.content = typeof raw.content === 'string' ? raw.content : String(raw.content ?? '');
  } else if (IMG_TYPES.has(type)) {
    const c = safeParse(raw.content);
    if (c && typeof c === 'object') {
      msg.image = resolveImage(c, baseDir);
      if (type.endsWith('_NOTE')) {
        msg.note = {
          title: typeof c.title === 'string' ? c.title : '',
          content: typeof c.content === 'string' ? c.content : '',
        };
      }
    }
  } else if (AUDIO_TYPES.has(type)) {
    const c = safeParse(raw.content);
    if (c && typeof c === 'object') {
      msg.audio = {
        serverpath: typeof c.serverpath === 'string' ? c.serverpath : '',
        localpath: typeof c.localpath === 'string' ? c.localpath : '',
        localPath: resolveLocalFile([c.localpath], baseDir),
      };
    }
  } else {
    msg.content = typeof raw.content === 'string' ? raw.content : '';
  }
  return msg;
}

/** 解析单个导出文件，返回规范化消息数组（保持导出顺序：新消息在前）。 */
function parseFile(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const text = extractArrayText(html);
  const rawMessages = parseArrayText(text);
  const baseDir = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
  return rawMessages.map((raw) => normalizeMessage(raw, baseDir));
}

function previewOf(msg) {
  if (msg.content != null && msg.content !== '') {
    return msg.content.replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  if (msg.image) return '[图片]';
  if (msg.audio) return '[语音]';
  return '[消息]';
}

function makeSummary(filePath, messages) {
  const title = path.basename(filePath, path.extname(filePath));
  const members = Array.from(new Set(messages.map((m) => m.fromName)));
  const newest = messages[0];
  return {
    title,
    filePath,
    msgCount: messages.length,
    memberCount: members.length,
    members,
    lastTime: newest ? newest.createdTime : 0,
    lastPreview: newest ? previewOf(newest) : '',
  };
}

/** 扫描文件夹内全部 .html，解析并缓存，按最近活跃倒序返回会话摘要。 */
function scanFolder(folder, cache = new Map()) {
  const summaries = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    return { summaries, errors: [{ file: folder, error: err.message }] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.html')) continue;
    const filePath = path.join(folder, entry.name);
    try {
      const messages = parseFile(filePath);
      cache.set(filePath, messages);
      summaries.push(makeSummary(filePath, messages));
    } catch (err) {
      errors.push({ file: entry.name, error: err.message });
    }
  }

  summaries.sort((a, b) => b.lastTime - a.lastTime);
  return { summaries, errors };
}

module.exports = {
  parseFile,
  scanFolder,
  extractArrayText,
  normalizeMessage,
  makeSummary,
  previewOf,
};
