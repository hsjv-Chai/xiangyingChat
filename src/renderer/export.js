'use strict';

const chatAPI = window.api;

const params = new URLSearchParams(window.location.search);
const title = params.get('title') || '';
const me = params.get('me') || '';
const idsParam = params.get('ids');
const ids = idsParam
  ? new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hashHue(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

function avatarHtml(text) {
  const name = String(text || '?');
  return (
    '<span class="avatar" style="background:hsl(' + hashHue(name) + ',42%,55%)">' +
    escapeHtml(name.slice(0, 1)) +
    '</span>'
  );
}

function dayLabel(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

function renderText(text) {
  let html = escapeHtml(text);
  html = html.replace(/(https?:\/\/[^\s<>"']+)/g, (match) => {
    return '<a class="msg-link">' + match + '</a>';
  });
  return '<span class="msg-text">' + html + '</span>';
}

function quoteHtml(msg) {
  if (!msg.quote || typeof msg.quote !== 'object') return '';
  const name = String(msg.quote.fromName || msg.quote.sender || '引用');
  const content = String(msg.quote.content || '');
  const shown = content.length > 120 ? content.slice(0, 120) + '…' : content;
  return '<div class="quote-card"><span class="quote-name">' + escapeHtml(name) +
    '</span>：' + escapeHtml(shown) + '</div>';
}

function bodyHtml(msg) {
  if (msg.note && (msg.note.title || msg.note.content)) {
    let html = '<div class="bubble">';
    if (msg.note.title) html += '<div class="note-title">' + escapeHtml(msg.note.title) + '</div>';
    if (msg.note.content) html += '<div class="note-content">' + escapeHtml(msg.note.content) + '</div>';
    if (msg.image && msg.image.src) {
      html += '<img class="msg-img" src="' + escapeHtml(msg.image.src) + '" alt="图片">';
    }
    return html + '</div>';
  }
  if (msg.content != null) {
    return '<div class="bubble">' + renderText(msg.content) + '</div>';
  }
  if (msg.image && msg.image.src) {
    return '<div class="bubble bubble-img"><img class="msg-img" src="' + escapeHtml(msg.image.src) + '" alt="图片"></div>';
  }
  if (msg.audio) {
    return '<div class="bubble"><span class="audio-text">▶ 语音</span></div>';
  }
  return '<div class="bubble unknown">[不支持的消息类型]</div>';
}

function rowFor(msg) {
  const isMe = me && msg.fromName === me;
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '');
  row.innerHTML =
    avatarHtml(msg.fromName) +
    '<div class="msg-body">' +
    (isMe ? '' : '<div class="msg-name">' + escapeHtml(msg.fromName) + '</div>') +
    quoteHtml(msg) +
    bodyHtml(msg) +
    '<div class="msg-time">' + dayLabel(msg.createdTime) + '</div>' +
    '</div>';
  return row;
}

function finish(naturalHeight) {
  document.body.style.width = '760px';
  document.body.style.height = Math.ceil(naturalHeight) + 'px';
  window.__exportReady = true;
  window.__exportWidth = 760;
  window.__exportHeight = Math.ceil(naturalHeight);
}

async function main() {
  const root = document.getElementById('export');
  const res = await chatAPI.loadConversation(title);
  if (!res || res.error) {
    root.innerHTML = '<div style="padding:60px;text-align:center;color:#94a3b8">' +
      escapeHtml((res && res.error) || '加载失败') + '</div>';
    finish(200);
    return;
  }

  const msgs = ids
    ? res.messages.filter((m) => ids.has(String(m.msgId)))
    : res.messages;
  if (msgs.length === 0) {
    root.innerHTML = '<div style="padding:60px;text-align:center;color:#94a3b8">没有选中的消息</div>';
    finish(200);
    return;
  }
  const header = document.createElement('div');
  header.className = 'export-header';
  header.innerHTML =
    '<div class="export-title">' + escapeHtml(title) + '</div>' +
    '<div class="export-sub">' + (ids ? '已选 ' : '共 ') + msgs.length + ' 条消息 · 由聊天记录阅读器导出</div>' +
    '<div class="export-rule"></div>';
  root.appendChild(header);

  const ordered = msgs.slice().reverse();
  let lastDay = '';
  for (const msg of ordered) {
    const d = new Date(msg.createdTime);
    const day = d.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      const dd = new Date(msg.createdTime);
      divider.innerHTML = '<span>' + dd.getFullYear() + '年' + (dd.getMonth() + 1) + '月' + dd.getDate() + '日</span>';
      root.appendChild(divider);
    }
    root.appendChild(rowFor(msg));
  }

  await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
  finish(root.getBoundingClientRect().height);
}

main();
