// Audience chat: Twitch (anonymous, read-only IRC over WebSocket) and YouTube
// (Data API with the user's API key). Any message can be put on screen as a
// "comment" title on a chosen overlay layer.
import { TitleInput } from './inputs.js';
import { app, changed, saveSettings, state } from './store.js';
import { openPanel } from './ui-common.js';
import { $, h } from './util.js';

const MAX_MESSAGES = 300;
const messages = [];
let unread = 0;
let shownId = null;
let seq = 0;

// --- Twitch ----------------------------------------------------------------------

const twitch = { ws: null, channel: '', status: 'off', retry: 0, timer: 0 };

function parseTags(raw) {
  const tags = {};
  for (const part of raw.slice(1).split(';')) {
    const [k, v = ''] = part.split('=');
    tags[k] = v.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
  }
  return tags;
}

function connectTwitch(channel) {
  disconnectTwitch();
  twitch.channel = channel.replace(/^#/, '').trim().toLowerCase();
  if (!twitch.channel) return;
  twitch.status = 'connecting';
  render();
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  twitch.ws = ws;
  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags');
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
    ws.send(`JOIN #${twitch.channel}`);
  };
  ws.onmessage = (e) => {
    for (const line of String(e.data).split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        ws.send(line.replace('PING', 'PONG'));
        continue;
      }
      if (/ 366 /.test(line) || / JOIN #/.test(line)) {
        twitch.status = 'on';
        twitch.retry = 0;
        render();
      }
      const m = /^(@\S+ )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line);
      if (!m) continue;
      const tags = m[1] ? parseTags(m[1].trim()) : {};
      addMessage({ platform: 'twitch', author: tags['display-name'] || m[2], color: tags.color || null, text: m[3] });
    }
  };
  ws.onclose = () => {
    if (twitch.ws !== ws) return;
    twitch.status = 'retry';
    render();
    twitch.retry = Math.min(twitch.retry + 1, 6);
    twitch.timer = setTimeout(() => connectTwitch(twitch.channel), 2 ** twitch.retry * 1000);
  };
}

function disconnectTwitch() {
  clearTimeout(twitch.timer);
  const ws = twitch.ws;
  twitch.ws = null;
  ws?.close();
  twitch.status = 'off';
}

// --- YouTube -------------------------------------------------------------------------

const youtube = { liveChatId: null, pageToken: null, timer: 0, status: 'off', error: null };

function videoIdFrom(text) {
  const t = String(text).trim();
  const m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/.exec(t);
  return m ? m[1] : /^[\w-]{11}$/.test(t) ? t : null;
}

async function api(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `Error ${res.status}`);
  return body;
}

async function connectYouTube(key, video) {
  disconnectYouTube();
  const id = videoIdFrom(video);
  if (!key || !id) {
    youtube.error = !key ? 'Falta la clave de API' : 'No reconozco el enlace o ID del directo';
    render();
    return;
  }
  youtube.status = 'connecting';
  youtube.error = null;
  render();
  try {
    const data = await api('videos', { part: 'liveStreamingDetails', id, key });
    const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) throw new Error('Ese vídeo no tiene un chat en directo activo');
    youtube.liveChatId = chatId;
    youtube.key = key;
    youtube.pageToken = null;
    youtube.status = 'on';
    render();
    pollYouTube(true);
  } catch (err) {
    youtube.status = 'off';
    youtube.error = err.message;
    render();
  }
}

async function pollYouTube(first = false) {
  if (youtube.status !== 'on') return;
  try {
    const data = await api('liveChat/messages', { liveChatId: youtube.liveChatId, part: 'snippet,authorDetails', key: youtube.key, pageToken: youtube.pageToken, maxResults: 200 });
    youtube.pageToken = data.nextPageToken;
    // The first page is history; only show the last few of it.
    const items = first ? (data.items ?? []).slice(-15) : data.items ?? [];
    for (const item of items) {
      const text = item.snippet?.displayMessage;
      if (text) addMessage({ platform: 'youtube', author: item.authorDetails?.displayName ?? '?', color: null, text });
    }
    youtube.timer = setTimeout(pollYouTube, Math.max(3000, data.pollingIntervalMillis ?? 5000));
  } catch (err) {
    youtube.error = err.message;
    render();
    youtube.timer = setTimeout(pollYouTube, 15000);
  }
}

function disconnectYouTube() {
  clearTimeout(youtube.timer);
  youtube.status = 'off';
  youtube.liveChatId = null;
}

// --- messages and on-screen comments ------------------------------------------------

function addMessage(msg) {
  messages.push({ ...msg, id: ++seq, at: Date.now() });
  if (messages.length > MAX_MESSAGES) messages.shift();
  if (!$('#dlg-chat').open) unread++;
  renderMessages();
  renderBadge();
}

function commentInput() {
  let input = state.inputs.find((i) => i.type === 'title' && i.fields.template === 'comment');
  if (!input) {
    input = new TitleInput({ template: 'comment', title: '', subtitle: '', bgColor: '#101218', bgOpacity: 0.92, textColor: '#ffffff' }, 'Comentario del chat');
    app.actions.addInput(input, { select: false });
  }
  return input;
}

function showOnScreen(msg) {
  const layer = Math.min(state.overlays.length, Math.max(1, state.settings.chatLayer || 4)) - 1;
  const input = commentInput();
  const ov = state.overlays[layer];
  if (shownId === msg.id && ov.inputId === input.id && ov.target > 0) {
    app.actions.toggleOverlay(layer, input.id); // hide
    shownId = null;
  } else {
    Object.assign(input.fields, { title: msg.text, subtitle: msg.author, platform: msg.platform, nameColor: msg.color });
    if (!(ov.inputId === input.id && ov.target > 0)) app.actions.toggleOverlay(layer, input.id);
    shownId = msg.id;
  }
  renderMessages();
  changed();
}

function hideComment() {
  const input = state.inputs.find((i) => i.type === 'title' && i.fields.template === 'comment');
  const layer = state.overlays.findIndex((ov) => input && ov.inputId === input.id && ov.target > 0);
  if (layer >= 0) app.actions.toggleOverlay(layer, input.id);
  shownId = null;
  renderMessages();
}

// --- UI ----------------------------------------------------------------------------------

const STATUS = { off: 'Desconectado', connecting: 'Conectando…', on: 'Conectado', retry: 'Reconectando…' };

function renderBadge() {
  const btn = $('#btn-chat');
  btn.dataset.badge = unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '';
}

function renderMessages() {
  const list = $('#chat-messages');
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(
    ...(messages.length
      ? messages.map((m) =>
          h('button', {
            type: 'button',
            class: `chat-msg ${m.id === shownId ? 'shown' : ''}`,
            title: m.id === shownId ? 'En pantalla · clic para quitar' : 'Clic para mostrarlo en pantalla',
            onclick: () => showOnScreen(m),
          },
          h('span', { class: `chat-platform ${m.platform}` }, m.platform === 'twitch' ? 'T' : '▶'),
          h('span', { class: 'chat-author', style: m.color ? `color:${m.color}` : null }, m.author),
          h('span', { class: 'chat-text' }, m.text)),
        )
      : [h('p', { class: 'muted small' }, 'Los mensajes aparecerán aquí. Haz clic en uno para ponerlo en pantalla.')]),
  );
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function render() {
  const s = state.settings;
  $('#chat-twitch-status').textContent = STATUS[twitch.status];
  $('#chat-twitch-status').className = `chip ${twitch.status === 'on' ? 'good' : ''}`;
  $('#chat-yt-status').textContent = youtube.error ? youtube.error : STATUS[youtube.status];
  $('#chat-yt-status').className = `chip ${youtube.status === 'on' ? 'good' : youtube.error ? 'warn' : ''}`;
  $('#chat-twitch').value ||= s.chatTwitch || '';
  $('#chat-yt-key').value ||= s.chatYoutubeKey || '';
  $('#chat-layer').value = String(s.chatLayer || 4);
}

export function openChat() {
  openPanel($('#dlg-chat'));
  unread = 0;
  renderBadge();
  render();
  renderMessages();
}

export function initChat() {
  state.settings.chatLayer ??= 4;
  $('#btn-chat').addEventListener('click', () => ($('#dlg-chat').open ? $('#dlg-chat').close() : openChat()));
  $('#btn-chat-close').addEventListener('click', () => $('#dlg-chat').close());
  $('#btn-chat-twitch').addEventListener('click', () => {
    const channel = $('#chat-twitch').value.trim();
    state.settings.chatTwitch = channel;
    saveSettings();
    if (!channel) return disconnectTwitch(), render();
    connectTwitch(channel);
  });
  $('#btn-chat-yt').addEventListener('click', () => {
    state.settings.chatYoutubeKey = $('#chat-yt-key').value.trim();
    saveSettings();
    connectYouTube(state.settings.chatYoutubeKey, $('#chat-yt-video').value);
  });
  $('#chat-layer').addEventListener('change', (e) => {
    state.settings.chatLayer = Number(e.target.value);
    saveSettings();
  });
  $('#btn-chat-hide').addEventListener('click', hideComment);
  $('#btn-chat-clear').addEventListener('click', () => {
    messages.length = 0;
    renderMessages();
  });
  if (state.settings.chatTwitch) connectTwitch(state.settings.chatTwitch);
  // Exposed so tests and the remote can inject or read messages.
  app.chat = { addMessage, messages, showOnScreen, hideComment };
}

