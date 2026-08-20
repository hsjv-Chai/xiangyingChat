'use strict';

const chatAPI = window.api;
const $ = (sel) => document.querySelector(sel);

const state = {
  conversations: [],
  currentTitle: null,
  messages: [],
  me: '',
  folderPath: '',
  query: '',
  matches: [],
  matchIndex: -1,
  zoom: 1,
  audio: {
    ctx: null,
    msgId: null,
    source: null,
    buffer: null,
    startedAt: 0,
    pausedAt: 0,
    duration: 0,
    playing: false,
    timer: null,
  },
  selectMode: false,
  selected: new Set(),
};

/* ---------------- 工具函数 ---------------- */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localimgUrl(absPath) {
  const clean = String(absPath).replace(/\\/g, '/').replace(/^\//, '');
  return 'localimg://local/' + clean.split('/').map(encodeURIComponent).join('/');
}

function hashHue(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

function avatarHtml(text, size) {
  const name = String(text || '?');
  return (
    '<span class="avatar" style="width:' + size + 'px;height:' + size + 'px;font-size:' +
    Math.round(size * 0.42) + 'px;background:hsl(' + hashHue(name) + ',42%,55%)">' +
    escapeHtml(name.slice(0, 1)) + '</span>'
  );
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (sameDay(d, now)) return hm;
  if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) {
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return '今天';
  if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/* ---------------- 消息渲染 ---------------- */

function renderText(text) {
  let html = escapeHtml(text);
  if (state.query) {
    const q = escapeRegExp(state.query);
    if (q) html = html.replace(new RegExp('(' + q + ')', 'gi'), '<mark>$1</mark>');
  }
  html = html.replace(/(https?:\/\/[^\s<>"']+)/g, (match) => {
    return '<a href="#" class="msg-link" data-url="' + match + '">' + match + '</a>';
  });
  return html;
}

function quoteHtml(msg) {
  if (!msg.quote || typeof msg.quote !== 'object') return '';
  const name = String(msg.quote.fromName || msg.quote.sender || '引用');
  const content = String(msg.quote.content || '');
  const shown = content.length > 120 ? content.slice(0, 120) + '…' : content;
  return '<div class="quote-card"><span class="quote-name">' + escapeHtml(name) +
    '</span>：' + escapeHtml(shown) + '</div>';
}

function imageHtml(msg) {
  const im = msg.image;
  const ratio = im.width && im.height ? ' style="aspect-ratio:' + im.width + '/' + im.height + '"' : '';
  return '<div class="bubble bubble-img"><img class="msg-img"' + ratio + ' src="' +
    escapeHtml(im.src) + '" alt="图片"></div>';
}

function bubbleHtml(msg) {
  if (msg.note && (msg.note.title || msg.note.content)) {
    let html = '<div class="bubble">';
    if (msg.note.title) html += '<div class="note-title">' + escapeHtml(msg.note.title) + '</div>';
    if (msg.note.content) html += '<div class="note-content">' + renderText(msg.note.content) + '</div>';
    if (msg.image && msg.image.src) {
      html += '<img class="msg-img" src="' + escapeHtml(msg.image.src) + '" alt="图片">';
    }
    return html + '</div>';
  }
  if (msg.content != null) {
    return '<div class="bubble">' + renderText(msg.content) + '</div>';
  }
  if (msg.image && msg.image.src) {
    return imageHtml(msg);
  }
  if (msg.audio) {
    const secs = msg.audio.voicelength || 0;
    return '<div class="bubble audio-bubble" data-audio="' + escapeHtml(msg.msgId) +
      '" data-secs="' + secs + '">' +
      '<span class="audio-icon">▶</span>' +
      '<span class="audio-label">语音</span>' +
      '<span class="audio-progress">' + (secs ? formatTime(secs) : '') + '</span>' +
      '</div>';
  }
  return '<div class="bubble bubble-unknown">[不支持的消息类型]</div>';
}

function messageRow(msg) {
  const isMe = state.me && msg.fromName === state.me;
  const msgId = String(msg.msgId);
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '') + (state.selected.has(msgId) ? ' selected' : '');
  row.dataset.msgId = msgId;
  row.innerHTML =
    '<div class="msg-check" title="选择此消息"></div>' +
    avatarHtml(msg.fromName, 36) +
    '<div class="msg-body">' +
    (isMe ? '' : '<div class="msg-name">' + escapeHtml(msg.fromName) + '</div>') +
    quoteHtml(msg) +
    bubbleHtml(msg) +
    '<div class="msg-time">' + fmtTime(msg.createdTime) + '</div>' +
    '</div>';
  return row;
}

function renderMessages() {
  const el = $('#messages');
  stopAudio();
  el.innerHTML = '';
  state.matches = [];
  state.matchIndex = -1;
  el.classList.toggle('select-mode', state.selectMode);

  // 导出为倒序（新消息在前），聊天视图按时间正序展示
  const ordered = state.messages.slice().reverse();
  let lastDay = '';
  for (const msg of ordered) {
    const day = new Date(msg.createdTime).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.innerHTML = '<span>' + dayLabel(msg.createdTime) + '</span>';
      el.appendChild(divider);
    }
    el.appendChild(messageRow(msg));
  }

  state.matches = Array.from(el.querySelectorAll('mark'));
  if (state.matches.length) {
    state.matchIndex = 0;
    highlightMatch(0);
  }
  updateMatchCount();
  el.scrollTop = el.scrollHeight;
}

/* ---------------- 选择导出模式 ---------------- */

function updateSelectCount() {
  $('#selectCount').textContent = state.selected.size;
}

function enterSelectionMode() {
  if (!state.currentTitle) {
    toast('请先选择一个会话');
    return;
  }
  state.selectMode = true;
  state.selected.clear();
  $('#selectBar').classList.add('show');
  const scrollTop = $('#messages').scrollTop;
  renderMessages();
  $('#messages').scrollTop = scrollTop;
  updateSelectCount();
}

function exitSelectionMode() {
  if (!state.selectMode) return;
  state.selectMode = false;
  state.selected.clear();
  $('#selectBar').classList.remove('show');
  const scrollTop = $('#messages').scrollTop;
  renderMessages();
  $('#messages').scrollTop = scrollTop;
}

function toggleSelect(msgId, row) {
  if (!state.selectMode) return;
  const id = String(msgId);
  if (state.selected.has(id)) {
    state.selected.delete(id);
    if (row) row.classList.remove('selected');
  } else {
    state.selected.add(id);
    if (row) row.classList.add('selected');
  }
  updateSelectCount();
}

function selectAllMessages() {
  if (!state.selectMode) return;
  state.selected = new Set(state.messages.map((m) => String(m.msgId)));
  document.querySelectorAll('#messages .msg-row').forEach((row) => {
    if (state.selected.has(row.dataset.msgId)) row.classList.add('selected');
  });
  updateSelectCount();
}

function clearMessageSelection() {
  if (!state.selectMode) return;
  state.selected.clear();
  document.querySelectorAll('#messages .msg-row').forEach((row) => row.classList.remove('selected'));
  updateSelectCount();
}

async function exportSelected() {
  if (!state.selectMode) return;
  if (state.selected.size === 0) {
    toast('请先选择要导出的消息');
    return;
  }
  toast('正在导出图片…');
  const res = await chatAPI.exportImage(state.currentTitle, Array.from(state.selected));
  if (res && res.saved) {
    toast('已导出：' + res.path);
    exitSelectionMode();
  } else if (res && res.canceled) {
    toast('已取消导出');
  } else {
    toast((res && res.error) || '导出失败');
  }
}

function highlightMatch(index) {
  state.matches.forEach((m, i) => m.classList.toggle('match-current', i === index));
  const target = state.matches[index];
  if (target) target.scrollIntoView({ block: 'center' });
  updateMatchCount();
}

function goMatch(delta) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + delta + state.matches.length) % state.matches.length;
  highlightMatch(state.matchIndex);
}

function updateMatchCount() {
  const total = state.matches.length;
  $('#matchCount').textContent = total ? (state.matchIndex + 1) + '/' + total : '0/0';
}

function selectContextMessage() {
  const selection = window.getSelection();
  selection.removeAllRanges();

  const msgId = window.__contextMsgId;
  let target = null;
  if (msgId) {
    const row = document.querySelector('.msg-row[data-msg-id="' + CSS.escape(msgId) + '"]');
    if (row) target = row.querySelector('.msg-body');
  }

  if (target) {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.addRange(range);
  } else if (!msgId) {
    document.execCommand('selectAll');
  }
}

window.__selectContextMessage = selectContextMessage;

/* ---------------- 会话列表 ---------------- */

function renderConvList() {
  const el = $('#convList');
  const q = $('#convSearch').value.trim().toLowerCase();
  const list = state.conversations.filter((c) => {
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      c.lastPreview.toLowerCase().includes(q) ||
      c.members.some((m) => m.toLowerCase().includes(q))
    );
  });

  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="conv-empty">没有匹配的会话</div>';
    return;
  }

  for (const c of list) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.title === state.currentTitle ? ' active' : '');
    item.innerHTML =
      avatarHtml(c.title, 40) +
      '<div class="conv-info">' +
      '<div class="conv-name">' + escapeHtml(c.title) + '</div>' +
      '<div class="conv-preview">' + escapeHtml(c.lastPreview) + '</div>' +
      '</div>' +
      '<div class="conv-time">' + fmtListTime(c.lastTime) + '</div>';
    item.addEventListener('click', () => selectConversation(c.title));
    el.appendChild(item);
  }
}

function renderHeader() {
  const c = state.conversations.find((x) => x.title === state.currentTitle);
  $('#chatTitle').textContent = c ? c.title : '';
  $('#chatSub').textContent = c ? c.msgCount + ' 条消息 · ' + c.memberCount + ' 位成员' : '';
}

function renderChatEmpty(text) {
  $('#chatTitle').textContent = '';
  $('#chatSub').textContent = '';
  $('#messages').innerHTML =
    '<div class="chat-empty">' +
    '<div class="chat-logo">' +
    '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>' +
    '</div>' +
    '<p>' + escapeHtml(text) + '</p>' +
    '<button class="primary-btn open-folder">打开文件夹</button>' +
    '</div>';
}

/* ---------------- 主要动作 ---------------- */

async function openFolder() {
  const res = await chatAPI.selectFolder();
  if (!res || res.canceled) return;
  state.folderPath = res.folder;
  state.conversations = res.conversations;
  state.currentTitle = null;
  state.messages = [];
  renderConvList();
  if (res.conversations.length) {
    await selectConversation(res.conversations[0].title);
  } else {
    renderChatEmpty('该文件夹中没有可读取的聊天记录');
  }
  if (res.errors && res.errors.length) {
    toast('已跳过 ' + res.errors.length + ' 个无法解析的文件');
  }
}

async function selectConversation(title) {
  if (state.selectMode) exitSelectionMode();
  const res = await chatAPI.loadConversation(title);
  if (!res || res.error) {
    toast(res ? res.error : '加载失败');
    return;
  }
  state.currentTitle = title;
  state.messages = res.messages;
  renderHeader();
  renderMessages();
  renderConvList();
}

/* ---------------- 设置 ---------------- */

function openSettings() {
  $('#settingsMe').value = state.me || '';
  $('#settingsFolder').textContent = state.folderPath || '未选择';
  $('#settingsModal').classList.add('show');
}

function closeSettings() {
  $('#settingsModal').classList.remove('show');
}

async function saveSettings() {
  const me = $('#settingsMe').value.trim();
  state.me = me;
  await chatAPI.saveSettings({ me });
  closeSettings();
  if (state.messages.length) renderMessages();
  toast('设置已保存');
}

/* ---------------- 灯箱 / 语音 / Toast ---------------- */

function openLightbox(src) {
  $('#lightboxImg').src = src;
  state.zoom = 1;
  applyZoom();
  $('#lightbox').classList.add('show');
}

function closeLightbox() {
  $('#lightbox').classList.remove('show');
  $('#lightboxImg').src = '';
}

function applyZoom() {
  $('#lightboxImg').style.transform = 'scale(' + state.zoom + ')';
}

function zoomBy(delta) {
  state.zoom = Math.min(8, Math.max(0.2, state.zoom + delta));
  applyZoom();
}

/* ---------------- 语音播放（AMR 解码 + Web Audio） ---------------- */

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function getAudioCtx() {
  if (!state.audio.ctx) {
    state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audio.ctx;
}

function setAudioBubbleUI() {
  const currentId = String(state.audio.msgId || '');
  document.querySelectorAll('.audio-bubble').forEach((el) => {
    const isCurrent = el.dataset.audio === currentId;
    el.classList.toggle('playing', isCurrent && state.audio.playing);
    const icon = el.querySelector('.audio-icon');
    const progress = el.querySelector('.audio-progress');
    if (!icon || !progress) return;
    if (isCurrent && state.audio.buffer) {
      icon.textContent = state.audio.playing ? '⏸' : '▶';
      const total = state.audio.duration || state.audio.buffer.duration;
      const pos = state.audio.playing
        ? Math.min(state.audio.ctx.currentTime - state.audio.startedAt, total)
        : state.audio.pausedAt;
      progress.textContent = formatTime(pos) + ' / ' + formatTime(total);
    } else {
      icon.textContent = '▶';
      const secs = Number(el.dataset.secs) || 0;
      progress.textContent = secs ? formatTime(secs) : '';
    }
  });
}

function startPlayback() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  if (state.audio.source) {
    try {
      state.audio.source.disconnect();
    } catch {
      /* ignore */
    }
  }
  const source = ctx.createBufferSource();
  source.buffer = state.audio.buffer;
  source.connect(ctx.destination);
  const offset = Math.min(state.audio.pausedAt, state.audio.buffer.duration);
  source.start(0, offset);
  state.audio.source = source;
  state.audio.startedAt = ctx.currentTime - offset;
  state.audio.pausedAt = offset;
  state.audio.playing = true;
  source.onended = () => {
    if (state.audio.source === source) {
      state.audio.playing = false;
      state.audio.source = null;
      state.audio.pausedAt = 0;
      clearInterval(state.audio.timer);
      state.audio.timer = null;
      setAudioBubbleUI();
    }
  };
  clearInterval(state.audio.timer);
  state.audio.timer = setInterval(setAudioBubbleUI, 250);
  setAudioBubbleUI();
}

function pauseAudio() {
  if (!state.audio.source || !state.audio.playing) return;
  state.audio.pausedAt = Math.min(
    state.audio.ctx.currentTime - state.audio.startedAt,
    state.audio.duration || state.audio.buffer.duration
  );
  try {
    state.audio.source.stop();
  } catch {
    /* ignore */
  }
  state.audio.source = null;
  state.audio.playing = false;
  clearInterval(state.audio.timer);
  state.audio.timer = null;
  setAudioBubbleUI();
}

function stopAudio() {
  if (state.audio.source) {
    try {
      state.audio.source.stop();
    } catch {
      /* ignore */
    }
    state.audio.source = null;
  }
  state.audio.msgId = null;
  state.audio.buffer = null;
  state.audio.playing = false;
  state.audio.pausedAt = 0;
  state.audio.duration = 0;
  clearInterval(state.audio.timer);
  state.audio.timer = null;
  setAudioBubbleUI();
}

async function playAudio(msgId) {
  const id = String(msgId);
  const msg = state.messages.find((m) => String(m.msgId) === id);
  if (!msg || !msg.audio) return;

  // 同一条：播放中则暂停，暂停中则继续
  if (state.audio.msgId === id && state.audio.playing) {
    pauseAudio();
    return;
  }
  if (state.audio.msgId === id && !state.audio.playing && state.audio.buffer) {
    startPlayback();
    return;
  }

  // 切换新语音：先停旧的
  if (state.audio.source) stopAudio();
  state.audio.msgId = id;
  state.audio.pausedAt = 0;
  setAudioBubbleUI();
  toast('正在加载语音…');

  const res = await chatAPI.getAudio({
    serverpath: msg.audio.serverpath,
    localpath: msg.audio.localpath,
  });
  if (!res || res.error) {
    state.audio.msgId = null;
    setAudioBubbleUI();
    toast((res && res.error) || '语音暂时无法播放');
    return;
  }

  let pcm;
  try {
    pcm = await globalThis.AMRDecode.decode(new Uint8Array(res.buffer));
  } catch (err) {
    console.error('AMR 解码失败:', err);
    state.audio.msgId = null;
    setAudioBubbleUI();
    toast('语音解码失败');
    return;
  }

  const samples = pcm.channelData[0] || new Float32Array(0);
  if (!samples.length) {
    state.audio.msgId = null;
    setAudioBubbleUI();
    toast('语音内容为空');
    return;
  }

  const ctx = getAudioCtx();
  const audioBuffer = ctx.createBuffer(1, samples.length, pcm.sampleRate || 8000);
  audioBuffer.copyToChannel(samples, 0);
  state.audio.buffer = audioBuffer;
  state.audio.duration = msg.audio.voicelength || audioBuffer.duration;
  startPlayback();
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------- 事件绑定 ---------------- */

function clearSearch() {
  state.query = '';
  $('#chatSearch').value = '';
  renderMessages();
}

function bindEvents() {
  document.addEventListener('contextmenu', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.msg-row') : null;
    window.__contextMsgId = row ? row.dataset.msgId : null;
  });

  $('#openFolderBtn').addEventListener('click', openFolder);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsSave').addEventListener('click', saveSettings);
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) closeSettings();
  });

  $('#convSearch').addEventListener('input', renderConvList);

  $('#chatSearchBtn').addEventListener('click', () => {
    const bar = $('#chatSearchBar');
    const showing = bar.classList.toggle('show');
    if (showing) {
      $('#chatSearch').value = state.query;
      $('#chatSearch').focus();
    } else {
      clearSearch();
    }
  });

  $('#exportBtn').addEventListener('click', () => {
    if (state.selectMode) exitSelectionMode();
    else enterSelectionMode();
  });
  $('#selectAllBtn').addEventListener('click', selectAllMessages);
  $('#clearSelBtn').addEventListener('click', clearMessageSelection);
  $('#exportSelBtn').addEventListener('click', exportSelected);
  $('#cancelSelBtn').addEventListener('click', exitSelectionMode);

  let searchTimer = null;
  $('#chatSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = $('#chatSearch').value;
      renderMessages();
    }, 180);
  });
  $('#chatSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goMatch(e.shiftKey ? -1 : 1);
    }
  });
  $('#prevBtn').addEventListener('click', () => goMatch(-1));
  $('#nextBtn').addEventListener('click', () => goMatch(1));
  $('#closeSearch').addEventListener('click', () => {
    $('#chatSearchBar').classList.remove('show');
    clearSearch();
  });

  $('#messages').addEventListener('click', (e) => {
    const row = e.target.closest('.msg-row');
    if (state.selectMode && row) {
      toggleSelect(row.dataset.msgId, row);
      return;
    }
    const link = e.target.closest('.msg-link');
    if (link) {
      e.preventDefault();
      chatAPI.openExternal(link.dataset.url);
      return;
    }
    const img = e.target.closest('.msg-img');
    if (img) {
      openLightbox(img.src);
      return;
    }
    const audio = e.target.closest('.audio-bubble');
    if (audio) {
      playAudio(audio.dataset.audio);
      return;
    }
    const folderBtn = e.target.closest('.open-folder');
    if (folderBtn) openFolder();
  });

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbSave').addEventListener('click', saveLightboxImage);
  $('#lbZoomIn').addEventListener('click', () => zoomBy(0.5));
  $('#lbZoomOut').addEventListener('click', () => zoomBy(-0.5));
  $('#lbReset').addEventListener('click', () => {
    state.zoom = 1;
    applyZoom();
  });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target === $('#lightbox')) closeLightbox();
  });
  $('#lightbox').addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.25 : -0.25);
    },
    { passive: false }
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.selectMode) exitSelectionMode();
      else if ($('#lightbox').classList.contains('show')) closeLightbox();
      else closeSettings();
    }
  });
}

async function saveLightboxImage() {
  const src = $('#lightboxImg').src;
  if (!src) return;
  toast('正在保存图片…');
  const res = await chatAPI.saveImage(src);
  if (res && res.saved) toast('已保存：' + res.path);
  else if (res && res.canceled) toast('已取消保存');
  else toast((res && res.error) || '保存失败');
}

function registerExportResultListener() {
  chatAPI.onExportResult((res) => {
    if (!res) return;
    if (res.saved) toast('已导出：' + res.path);
    else if (res.canceled) toast('已取消导出');
    else if (res.error) toast(res.error);
  });
}

/* ---------------- 初始化 ---------------- */

async function init() {
  bindEvents();
  registerExportResultListener();
  try {
    const res = await chatAPI.init();
    state.folderPath = res.settings.folder || '';
    state.me = res.settings.me || '';
    if (res.conversations && res.conversations.length) {
      state.conversations = res.conversations;
      renderConvList();
      await selectConversation(state.conversations[0].title);
    } else {
      renderConvList();
      renderChatEmpty(
        res.settings.folder
          ? '该文件夹中没有可读取的聊天记录'
          : '选择包含聊天记录导出的文件夹开始阅读'
      );
    }
  } catch (err) {
    renderChatEmpty('初始化失败：' + err.message);
  }
}

window.addEventListener('DOMContentLoaded', init);
