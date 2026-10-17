import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const app = express();
// Base64 media payloads can be larger than ordinary chat messages. The service
// validates decoded sizes separately before sending anything to WhatsApp.
app.use(express.json({ limit: '28mb' }));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SECRET = process.env.BRIDGE_SECRET || '';
const SERVICE_VERSION = '2.4.2';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './h2e-whatsapp-data');
const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR || path.join(DATA_DIR, 'sessions'));
const LEGACY_AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const CHAT_STORE_DIR = path.join(DATA_DIR, 'chat-store');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MAX_CACHED_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_MEDIA_BYTES = 16 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document']);
const mediaDownloadQueue = [];
const mediaDownloadQueued = new Set();
let mediaWorkerRunning = false;
const WP_INBOUND = process.env.WORDPRESS_INBOUND_URL || '';
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sessions = new Map();
let registry = [];

function authorized(req, res, next) {
  if (!SECRET || req.get('x-h2e-secret') !== SECRET) return res.status(401).json({ error: 'Não autorizado' });
  next();
}
function unwrapMessage(message) {
  let value = message || {};
  for (let i = 0; i < 5; i++) {
    const next = value.ephemeralMessage?.message || value.viewOnceMessage?.message || value.viewOnceMessageV2?.message || value.viewOnceMessageV2Extension?.message || value.documentWithCaptionMessage?.message || value.editedMessage?.message;
    if (!next) break;
    value = next;
  }
  return value;
}
function messageType(m) {
  const msg = unwrapMessage(m?.message);
  const types = {
    conversation: 'text', extendedTextMessage: 'text', imageMessage: 'image', videoMessage: 'video',
    audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker', locationMessage: 'location',
    liveLocationMessage: 'location', contactMessage: 'contact', contactsArrayMessage: 'contacts',
    buttonsResponseMessage: 'text', listResponseMessage: 'text', templateButtonReplyMessage: 'text',
    reactionMessage: 'reaction', pollCreationMessage: 'poll', pollUpdateMessage: 'poll'
  };
  for (const key of Object.keys(msg)) if (types[key]) return types[key];
  return 'unknown';
}
function textFromMessage(m) {
  const msg = unwrapMessage(m?.message);
  const body = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || msg.buttonsResponseMessage?.selectedDisplayText || msg.listResponseMessage?.title || msg.templateButtonReplyMessage?.selectedDisplayText || msg.contactMessage?.displayName || msg.contactsArrayMessage?.displayName || msg.locationMessage?.name || msg.locationMessage?.address || msg.pollCreationMessage?.name || msg.pollCreationMessageV3?.name;
  if (body) return String(body);
  const placeholders = { image: '[Imagem]', video: '[Vídeo]', audio: '[Áudio]', document: '[Documento]', sticker: '[Figurinha]', location: '[Localização]', contact: '[Contato]', contacts: '[Contatos]', reaction: '[Reação]', poll: '[Enquete]' };
  return placeholders[messageType(m)] || '';
}
function toSeconds(value) {
  if (value && typeof value === 'object') {
    if (typeof value.toNumber === 'function') value = value.toNumber();
    else if (value.low !== undefined) value = value.low;
  }
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}
function jidPhone(jid, alt = '') {
  const candidates = [alt, jid].filter(Boolean).map(v => String(v));
  for (const candidate of candidates) {
    if (!candidate.endsWith('@s.whatsapp.net') && !/^\+?\d{7,20}$/.test(candidate.split('@')[0].split(':')[0])) continue;
    const digits = candidate.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 20) return digits;
  }
  return '';
}
function ignoredJid(jid) {
  const v = String(jid || '');
  return !v || v === 'status@broadcast' || v.endsWith('@broadcast') || v.endsWith('@newsletter');
}
function chatStatePath(id) { return path.join(CHAT_STORE_DIR, `${id}.json`); }
function loadChatState(id) {
  try {
    const data = JSON.parse(fs.readFileSync(chatStatePath(id), 'utf8'));
    return { chats: Array.isArray(data.chats) ? data.chats : [], contacts: Array.isArray(data.contacts) ? data.contacts : [] };
  } catch (_) { return { chats: [], contacts: [] }; }
}
function persistChatState(id) {
  const run = sessions.get(id);
  if (!run) return;
  try {
    fs.mkdirSync(CHAT_STORE_DIR, { recursive: true });
    const chats = [...run.chats.values()].sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0)).slice(0, 1500).map(chat => ({
      jid: chat.jid, phone: chat.phone || '', name: chat.name || '', isGroup: !!chat.isGroup,
      isBusiness: !!chat.isBusiness, savedInWhatsApp: !!chat.savedInWhatsApp,
      unreadCount: Number(chat.unreadCount || 0), archived: !!chat.archived,
      lastMessage: chat.lastMessage || '', lastTimestamp: Number(chat.lastTimestamp || 0), lastFromMe: !!chat.lastFromMe,
      messages: (Array.isArray(chat.messages) ? chat.messages : []).slice(-150).map(m => ({ ...m, mediaStored: !!m.mediaStored, mimeType: m.mimeType || '', fileName: m.fileName || '', mediaSize: Number(m.mediaSize || 0) }))
    }));
    const contacts = [...run.contacts.values()].slice(0, 3000).map(c => ({
      id: c.id, name: c.name || '', notify: c.notify || '', verifiedName: c.verifiedName || '',
      businessName: c.businessName || '', isBusiness: !!c.isBusiness, savedInWhatsApp: !!c.savedInWhatsApp,
      phone: c.phone || ''
    }));
    const target = chatStatePath(id), tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), chats, contacts }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) { logger.warn({ accountId: id, code: e.code || null, error: e.message }, 'Could not persist WhatsApp chats cache'); }
}
function chatNameCandidate(...values) {
  for (const v of values) {
    const x = String(v || '').trim();
    if (x && !/^\+?[\d\s().-]+$/.test(x)) return x.slice(0, 190);
  }
  return '';
}
function ensureChat(run, jid) {
  let chat = run.chats.get(jid);
  if (!chat) {
    const contact = run.contacts.get(jid) || {};
    chat = {
      jid, phone: contact.phone || jidPhone(jid), name: chatNameCandidate(contact.verifiedName, contact.name, contact.notify),
      isGroup: jid.endsWith('@g.us'), isBusiness: !!contact.isBusiness || !!contact.verifiedName,
      savedInWhatsApp: !!contact.savedInWhatsApp, unreadCount: 0, archived: false,
      lastMessage: '', lastTimestamp: 0, lastFromMe: false, messages: []
    };
    run.chats.set(jid, chat);
  }
  const contact = run.contacts.get(jid);
  if (contact) {
    chat.phone = contact.phone || chat.phone || jidPhone(jid);
    chat.name = chatNameCandidate(contact.verifiedName, contact.name, contact.notify, chat.name) || chat.name;
    chat.savedInWhatsApp = !!contact.savedInWhatsApp;
    chat.isBusiness = !!chat.isBusiness || !!contact.isBusiness || !!contact.verifiedName;
  }
  chat.isGroup = !!chat.isGroup || jid.endsWith('@g.us');
  return chat;
}
function cacheContact(accountId, input, persist = true) {
  const run = getAccount(accountId);
  const id = String(input?.id || input?.jid || '').trim();
  if (ignoredJid(id)) return;
  const previous = run.contacts.get(id) || {};
  const name = chatNameCandidate(input.name, input.notify, input.verifiedName, previous.name);
  const contact = {
    id,
    name: name || '',
    notify: chatNameCandidate(input.notify, previous.notify) || '',
    verifiedName: chatNameCandidate(input.verifiedName, previous.verifiedName) || '',
    businessName: chatNameCandidate(input.businessName, previous.businessName) || '',
    isBusiness: !!input.isBusiness || !!input.verifiedName || !!previous.isBusiness,
    savedInWhatsApp: !!(input.name || input.notify || input.verifiedName || previous.savedInWhatsApp),
    phone: jidPhone(id, input.phoneNumber || input.phone || previous.phone)
  };
  run.contacts.set(id, contact);
  const chat = ensureChat(run, id);
  if (contact.name) chat.name = contact.name;
  chat.phone = contact.phone || chat.phone;
  chat.savedInWhatsApp = contact.savedInWhatsApp;
  chat.isBusiness = chat.isBusiness || contact.isBusiness;
  if (persist) persistChatState(accountId);
}
function cacheChatMeta(accountId, item, persist = true) {
  const jid = String(item?.id || item?.jid || '').trim();
  if (ignoredJid(jid)) return;
  const run = getAccount(accountId);
  const chat = ensureChat(run, jid);
  const candidate = chatNameCandidate(item.name, item.subject, item.displayName);
  if (candidate) chat.name = candidate;
  chat.phone = jidPhone(jid, item.phone || item.phoneNumber || item.idAlt) || chat.phone || '';
  chat.isGroup = jid.endsWith('@g.us') || !!item.isGroup || chat.isGroup;
  chat.isBusiness = !!item.isBusiness || !!item.verifiedName || chat.isBusiness;
  if (item.unreadCount !== undefined) chat.unreadCount = Math.max(0, Number(item.unreadCount) || 0);
  if (item.archive !== undefined) chat.archived = !!item.archive;
  if (item.archived !== undefined) chat.archived = !!item.archived;
  const ts = toSeconds(item.conversationTimestamp || item.lastTimestamp || item.timestamp || 0);
  if (ts > 0 && ts > Number(chat.lastTimestamp || 0)) chat.lastTimestamp = ts;
  if (persist) persistChatState(accountId);
}
function safeMediaName(value, fallback = 'arquivo') {
  const cleaned = String(value || '').replace(/[\\/\0\r\n]/g, '_').replace(/[<>:"|?*]/g, '_').trim().slice(0, 150);
  return cleaned || fallback;
}
function mediaDiskPath(accountId, messageId) {
  const safeAccount = String(accountId || 'account').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90) || 'account';
  const safeId = crypto.createHash('sha256').update(String(messageId || '')).digest('hex');
  return path.join(MEDIA_DIR, safeAccount, `${safeId}.bin`);
}
function mediaDescriptor(message) {
  const msg = unwrapMessage(message?.message);
  const candidates = [
    ['imageMessage', 'image', 'image/jpeg', 'imagem.jpg'],
    ['videoMessage', 'video', 'video/mp4', 'video.mp4'],
    ['audioMessage', 'audio', 'audio/ogg', 'audio.ogg'],
    ['documentMessage', 'document', 'application/octet-stream', 'arquivo'],
    ['stickerMessage', 'sticker', 'image/webp', 'figurinha.webp']
  ];
  for (const [key, type, defaultMime, defaultName] of candidates) {
    const part = msg?.[key];
    if (!part) continue;
    const mimeType = String(part.mimetype || defaultMime).split(';')[0].trim().slice(0, 150);
    const fileName = safeMediaName(part.fileName || part.title || defaultName, defaultName);
    let fileLength = part.fileLength || 0;
    try { if (typeof fileLength?.toNumber === 'function') fileLength = fileLength.toNumber(); else if (fileLength && typeof fileLength === 'object' && fileLength.low !== undefined) fileLength = fileLength.low; fileLength = Number(fileLength) || 0; } catch (_) { fileLength = 0; }
    return { type, mimeType, fileName, caption: String(part.caption || ''), fileLength };
  }
  return null;
}
function writeStoredMedia(accountId, messageId, buffer, mimeType, fileName) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length || buffer.length > MAX_CACHED_MEDIA_BYTES) throw new Error(`Mídia vazia ou acima do limite local de ${Math.round(MAX_CACHED_MEDIA_BYTES / 1024 / 1024)} MB.`);
  const target = mediaDiskPath(accountId, messageId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, buffer, { mode: 0o600 });
  fs.renameSync(temp, target);
  const run = getAccount(accountId);
  for (const chat of run?.chats?.values?.() || []) {
    const entry = (chat.messages || []).find(item => String(item.id) === String(messageId));
    if (entry) {
      entry.mediaStored = true;
      entry.mimeType = String(mimeType || entry.mimeType || 'application/octet-stream').slice(0, 150);
      entry.fileName = safeMediaName(fileName || entry.fileName || 'arquivo');
      entry.mediaSize = buffer.length;
      persistChatState(accountId);
      break;
    }
  }
  return { path: target, size: buffer.length };
}
async function downloadAndStoreMedia(accountId, message) {
  const key = message?.key || {};
  const messageId = String(key.id || '');
  const jid = String(key.remoteJid || key.remoteJidAlt || '');
  const descriptor = mediaDescriptor(message);
  if (!messageId || !jid || !descriptor) return;
  const run = getAccount(accountId);
  if (!run) return;
  if (descriptor.fileLength > MAX_CACHED_MEDIA_BYTES) throw new Error(`Mídia declarada com ${descriptor.fileLength} bytes; limite local ${MAX_CACHED_MEDIA_BYTES}.`);
  const target = mediaDiskPath(accountId, messageId);
  if (fs.existsSync(target)) {
    const chat = run.chats.get(jid);
    const saved = chat?.messages?.find(item => String(item.id) === messageId);
    if (saved && !saved.mediaStored) { saved.mediaStored = true; persistChatState(accountId); }
    return;
  }
  const buffer = await downloadMediaMessage(message, 'buffer', {}, {
    logger,
    reuploadRequest: run.sock?.updateMediaMessage
  });
  const result = writeStoredMedia(accountId, messageId, buffer, descriptor.mimeType, descriptor.fileName);
  logger.info({ accountId, messageId, type: descriptor.type, bytes: result.size }, 'WhatsApp media cached');
}
function enqueueMediaDownload(accountId, message) {
  const id = String(message?.key?.id || '');
  if (!id || !mediaDescriptor(message)) return;
  const key = `${accountId}:${id}`;
  if (mediaDownloadQueued.has(key) || mediaDownloadQueue.length >= 250) return;
  mediaDownloadQueued.add(key);
  mediaDownloadQueue.push({ accountId, message, key });
  if (mediaWorkerRunning) return;
  mediaWorkerRunning = true;
  void (async () => {
    while (mediaDownloadQueue.length) {
      const job = mediaDownloadQueue.shift();
      try { await downloadAndStoreMedia(job.accountId, job.message); }
      catch (e) { logger.warn({ accountId: job.accountId, messageId: job.message?.key?.id || '', code: e.code || null, error: e.message }, 'Could not download WhatsApp media'); }
      finally { mediaDownloadQueued.delete(job.key); }
    }
    mediaWorkerRunning = false;
  })();
}
function cacheMessage(accountId, message, options = {}) {
  const key = message?.key || {};
  const jid = String(key.remoteJid || key.remoteJidAlt || message?.jid || '').trim();
  if (ignoredJid(jid)) return null;
  const run = getAccount(accountId);
  const chat = ensureChat(run, jid);
  const type = messageType(message);
  const text = textFromMessage(message) || (type !== 'unknown' ? `[${type}]` : '');
  const timestamp = toSeconds(message.messageTimestamp || message.timestamp || message.messageStubParameters?.[0]) || Math.floor(Date.now() / 1000);
  const id = String(key.id || message.id || `${jid}:${timestamp}:${key.fromMe ? 'out' : 'in'}`);
  const fromMe = !!key.fromMe;
  const msgKey = { remoteJid: key.remoteJid || jid, id, fromMe, ...(key.participant ? { participant: key.participant } : {}) };
  const index = chat.messages.findIndex(m => String(m.id) === id);
  const previous = index >= 0 ? chat.messages[index] : {};
  const descriptor = mediaDescriptor(message);
  const diskPath = mediaDiskPath(accountId, id);
  const saved = {
    id, jid, fromMe, text, type, timestamp,
    status: fromMe ? 'sent' : 'received',
    ...(key.participant ? { participant: key.participant } : {}), key: msgKey,
    mimeType: descriptor?.mimeType || previous.mimeType || '',
    fileName: descriptor?.fileName || previous.fileName || '',
    mediaStored: !!previous.mediaStored || fs.existsSync(diskPath),
    mediaSize: Number(previous.mediaSize || 0)
  };
  if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...saved };
  else chat.messages.push(saved);
  chat.messages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  if (chat.messages.length > 150) chat.messages = chat.messages.slice(-150);
  const candidate = chatNameCandidate(message.pushName, message.notifyName);
  if (candidate && (!chat.name || chat.name === chat.phone || /^\d+$/.test(chat.name))) chat.name = candidate;
  chat.phone = jidPhone(jid, key.remoteJidAlt) || chat.phone || '';
  if (timestamp >= Number(chat.lastTimestamp || 0)) {
    chat.lastMessage = text;
    chat.lastTimestamp = timestamp;
    chat.lastFromMe = fromMe;
  }
  chat.isGroup = chat.isGroup || jid.endsWith('@g.us');
  if (!fromMe && options.incrementUnread) chat.unreadCount = Number(chat.unreadCount || 0) + 1;
  if (fromMe && options.incrementUnread) chat.unreadCount = 0;
  if (options.persist !== false) persistChatState(accountId);
  return { chat, message: saved };
}
function publicChat(chat) {
  return {
    jid: chat.jid, phone: chat.phone || jidPhone(chat.jid), name: chat.name || chat.phone || chat.jid,
    isGroup: !!chat.isGroup, isBusiness: !!chat.isBusiness, savedInWhatsApp: !!chat.savedInWhatsApp,
    unreadCount: Number(chat.unreadCount || 0), archived: !!chat.archived,
    lastMessage: chat.lastMessage || '', lastTimestamp: Number(chat.lastTimestamp || 0), lastFromMe: !!chat.lastFromMe,
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0
  };
}
function listChats(accountId) {
  const run = getAccount(accountId);
  // Include address-book contacts even if they have not started a conversation yet.
  for (const contact of run.contacts.values()) ensureChat(run, contact.id);
  return [...run.chats.values()].filter(c => !ignoredJid(c.jid)).map(publicChat)
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0) || String(a.name).localeCompare(String(b.name)));
}
function getChatMessages(accountId, jid) {
  const run = getAccount(accountId);
  let chat = run.chats.get(jid);
  // Let a saved CRM contact start a new WhatsApp conversation even before it
  // appears in the WhatsApp address-book/history cache.
  if (!chat && /^\d{7,20}@s\.whatsapp\.net$/.test(String(jid || ''))) {
    chat = ensureChat(run, jid);
    persistChatState(accountId);
  }
  if (!chat) return { chat: null, messages: [] };
  return { chat: publicChat(chat), messages: (chat.messages || []).map(m => ({
    id: m.id, jid: m.jid, fromMe: !!m.fromMe, text: m.text || '', type: m.type || 'text',
    timestamp: Number(m.timestamp || 0), status: m.status || '', participant: m.participant || '',
    mediaStored: !!m.mediaStored, mimeType: m.mimeType || '', fileName: m.fileName || '', mediaSize: Number(m.mediaSize || 0)
  })).sort((a, b) => a.timestamp - b.timestamp) };
}
function cleanProxy(value) {
  const proxy = String(value || '').trim();
  if (!proxy) return '';
  let parsed;
  try { parsed = new URL(proxy); } catch (_) { throw new Error('URL de proxy inválida. Use http://, https:// ou socks5://.'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new Error('Protocolo de proxy não suportado.');
  return proxy;
}
function proxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  return proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}
function persistRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempFile = path.join(DATA_DIR, `.accounts-${process.pid}-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, ACCOUNTS_FILE);
  } catch (e) {
    logger.error({ code: e.code || null, error: e.message }, 'Unable to persist WhatsApp account registry');
    throw new Error(`Não foi possível salvar as contas do WhatsApp. Verifique se DATA_DIR é gravável e persistente (erro ${e.code || 'filesystem'}).`);
  }
}
function findMeta(id) { return registry.find(a => a.id === id); }
function getAccount(id) {
  const meta = findMeta(id);
  if (!meta) return null;
  let runtime = sessions.get(id);
  if (!runtime) {
    const saved = loadChatState(id);
    runtime = {
      id, sock: null, qr: '', connected: false, connecting: false, lastError: '', phone: '',
      startPromise: null, intentionalClose: false,
      chats: new Map((saved.chats || []).filter(c => c && c.jid).map(c => [String(c.jid), c])),
      contacts: new Map((saved.contacts || []).filter(c => c && c.id).map(c => [String(c.id), c]))
    };
    sessions.set(id, runtime);
  }
  return runtime;
}
function accountAuthDir(id) {
  return path.join(SESSIONS_ROOT, id);
}
function directoryHasFiles(dir) {
  try { return fs.readdirSync(dir).length > 0; } catch (_) { return false; }
}
function migrateLegacySession() {
  if (!registry.some(a => a.id === 'principal')) return;
  const target = accountAuthDir('principal');
  if (directoryHasFiles(target) || !directoryHasFiles(LEGACY_AUTH_DIR)) return;
  try { fs.mkdirSync(target, { recursive: true }); fs.cpSync(LEGACY_AUTH_DIR, target, { recursive: true }); logger.info('Legacy WhatsApp session copied into the multi-account session directory.'); }
  catch (e) { logger.warn({ err: e.message }, 'Could not migrate legacy session directory'); }
}
function publicAccount(meta) {
  const run = getAccount(meta.id);
  return {
    id: meta.id, name: meta.name,
    connected: !!run.connected, connecting: !!run.connecting, hasQr: !!run.qr,
    phone: run.phone || '', lastError: run.lastError || '',
    delayMin: Number(meta.delayMin ?? 5), delayMax: Number(meta.delayMax ?? 30),
    proxyUrl: meta.proxyUrl || '', proxyConfigured: !!meta.proxyUrl
  };
}
async function notifyWordPress(payload) {
  if (!WP_INBOUND) return;
  try {
    const response = await fetch(WP_INBOUND, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-h2e-secret': SECRET },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) logger.warn({ status: response.status }, 'WordPress inbound callback failed');
  } catch (e) { logger.warn({ err: e.message }, 'WordPress callback unavailable'); }
}
function normalizeMeta(meta) {
  return {
    id: String(meta.id || crypto.randomUUID()),
    name: String(meta.name || 'Conta WhatsApp').slice(0, 80),
    delayMin: Math.max(0, Math.min(3600, Number(meta.delayMin ?? 5) || 0)),
    delayMax: Math.max(0, Math.min(3600, Number(meta.delayMax ?? 30) || 0)),
    proxyUrl: String(meta.proxyUrl || '')
  };
}
async function startAccount(id) {
  const meta = findMeta(id);
  if (!meta) throw new Error('Conta não encontrada.');
  const run = getAccount(id);
  if (run.startPromise) return run.startPromise;
  if (run.connected || run.connecting) return true;
  run.startPromise = (async () => {
    run.connecting = true; run.lastError = ''; run.intentionalClose = false;
    try {
      const authDir = accountAuthDir(id);
      fs.mkdirSync(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      // Query WhatsApp Web itself for its current protocol version. The older
      // fetchLatestBaileysVersion() helper can return a stale version and produce
      // a QR that scans but cannot finish linking.
      let versionInfo;
      try {
        versionInfo = await fetchLatestWaWebVersion();
      } catch (versionError) {
        throw new Error('Não foi possível consultar a versão atual do WhatsApp Web: ' + (versionError?.message || 'falha de rede'));
      }
      if (!versionInfo?.version || versionInfo.isLatest === false) {
        const detail = versionInfo?.error?.message ? ': ' + versionInfo.error.message : '';
        throw new Error('A versão atual do WhatsApp Web não pôde ser validada. Verifique a saída HTTPS da Hostinger para web.whatsapp.com' + detail);
      }
      const version = versionInfo.version;
      logger.info({ accountId: id, waWebVersion: version.join('.') }, 'Using live WhatsApp Web version');
      const agent = proxyAgent(meta.proxyUrl);
      const sock = makeWASocket({
        auth: state, version, logger, printQRInTerminal: false,
        browser: ['H2E CRM WhatsApp', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true,
        ...(agent ? { agent, fetchAgent: agent } : {})
      });
      run.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      const storeContacts = (items) => { for (const c of items || []) cacheContact(id, c, false); persistChatState(id); };
      const storeChats = (items) => { for (const c of items || []) cacheChatMeta(id, c, false); persistChatState(id); };
      sock.ev.on('contacts.upsert', storeContacts);
      sock.ev.on('contacts.update', storeContacts);
      sock.ev.on('contacts.set', event => storeContacts(event?.contacts || []));
      sock.ev.on('chats.upsert', storeChats);
      sock.ev.on('chats.update', storeChats);
      sock.ev.on('chats.set', event => storeChats(event?.chats || []));
      sock.ev.on('messaging-history.set', event => {
        try {
          for (const c of event?.contacts || []) cacheContact(id, c, false);
          for (const c of event?.chats || []) cacheChatMeta(id, c, false);
          const historyMessages = event?.messages || [];
          for (const m of historyMessages) cacheMessage(id, m, { persist: false, incrementUnread: false });
          for (const m of historyMessages.filter(m => mediaDescriptor(m)).slice(-80)) enqueueMediaDownload(id, m);
          persistChatState(id);
          logger.info({ accountId: id, chats: (event?.chats || []).length, contacts: (event?.contacts || []).length, messages: historyMessages.length, mediaQueued: historyMessages.filter(m => mediaDescriptor(m)).slice(-80).length, isLatest: !!event?.isLatest }, 'WhatsApp history synchronized');
        } catch (e) { logger.warn({ accountId: id, error: e.message }, 'Could not process WhatsApp history'); }
      });
      sock.ev.on('messages.update', updates => {
        const runState = getAccount(id);
        for (const update of updates || []) {
          const k = update?.key || {}; const jid = String(k.remoteJid || ''); const chat = runState.chats.get(jid);
          if (!chat || !Array.isArray(chat.messages)) continue;
          const message = chat.messages.find(m => m.id === k.id);
          if (message && update.update?.status !== undefined) message.status = String(update.update.status);
        }
        persistChatState(id);
      });
      sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try { run.qr = await QRCode.toDataURL(qr, { width: 280, margin: 2 }); }
          catch (err) { run.lastError = 'Não foi possível gerar QR Code: ' + err.message; }
          run.connected = false; run.connecting = false;
        }
        if (connection === 'open') {
          run.connected = true; run.connecting = false; run.qr = '';
          run.phone = sock?.user?.id?.split(':')[0]?.split('@')[0] || '';
          run.lastError = '';
          logger.info({ accountId: id, phone: run.phone }, 'WhatsApp account connected');
        }
        if (connection === 'close') {
          run.connected = false; run.connecting = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          const closeMessage = lastDisconnect?.error?.message || 'Motivo não informado';
          logger.warn({ accountId: id, code: code ?? null, error: closeMessage }, 'WhatsApp connection closed');
          if (run.intentionalClose) { run.intentionalClose = false; run.startPromise = null; return; }
          if (code === DisconnectReason.loggedOut) {
            run.lastError = 'Esta sessão foi desconectada pelo WhatsApp. Gere um novo QR Code.';
            run.qr = ''; run.startPromise = null;
          } else {
            run.lastError = 'Conexão interrompida; tentando reconectar.';
            run.startPromise = null;
            setTimeout(() => startAccount(id).catch(err => logger.warn({ accountId: id, err: err.message }, 'Reconnect failed')), 2500);
          }
        }
      });
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        let changed = false;
        for (const m of messages || []) {
          const key = m.key || {};
          const jid = String(key.remoteJid || key.remoteJidAlt || '');
          if (!m.message || ignoredJid(jid)) continue;
          const cached = cacheMessage(id, m, { persist: false, incrementUnread: type === 'notify' });
          if (cached) changed = true;
          if (mediaDescriptor(m)) enqueueMediaDownload(id, m);
          // Import new direct inbound text/media messages into the CRM contact history.
          // Group chats and LID-only identities stay in the Node inbox cache to avoid
          // creating invalid phone records in the CRM's telephone field.
          if (type === 'notify' && !key.fromMe && jid.endsWith('@s.whatsapp.net')) {
            const from = jidPhone(jid, key.remoteJidAlt);
            const body = textFromMessage(m);
            if (from && body) {
              await notifyWordPress({
                event: 'message', accountId: id, accountName: meta.name, from,
                name: m.pushName || from, text: body, id: key.id || '',
                timestamp: toSeconds(m.messageTimestamp), type: messageType(m)
              });
            }
          }
        }
        if (changed) persistChatState(id);
      });
      return true;
    } catch (e) {
      run.connecting = false; run.lastError = e.message || 'Falha ao iniciar WhatsApp'; run.startPromise = null; throw e;
    }
  })();
  try { return await run.startPromise; } finally { if (!run.connected) run.startPromise = null; }
}
async function createAccount(name) {
  const safeName = String(name || '').trim().slice(0, 80);
  if (!safeName) throw new Error('Informe um nome para a conta.');
  if (registry.some(a => a.name.toLowerCase() === safeName.toLowerCase())) {
    throw new Error('Já existe uma conta com esse nome. Escolha outro nome para identificá-la.');
  }
  const meta = normalizeMeta({ id: crypto.randomUUID(), name: safeName, delayMin: 5, delayMax: 30, proxyUrl: '' });
  registry.push(meta);
  try { persistRegistry(); }
  catch (e) { registry = registry.filter(a => a.id !== meta.id); throw e; }
  getAccount(meta.id);
  logger.info({ accountId: meta.id, name: meta.name, accountCount: registry.length }, 'WhatsApp account record created');
  startAccount(meta.id).catch(err => logger.warn({ accountId: meta.id, err: err.message }, 'Account start failed'));
  return publicAccount(meta);
}
async function removeAccount(id) {
  const meta = findMeta(id);
  if (!meta) throw new Error('Conta não encontrada.');
  const run = getAccount(id);
  run.intentionalClose = true;
  try { if (run.sock) { try { await run.sock.logout(); } catch (_) { try { run.sock.end(undefined); } catch (_) {} } } } catch (_) {}
  run.sock = null; run.connected = false; run.connecting = false; run.qr = ''; run.startPromise = null;
  registry = registry.filter(a => a.id !== id); persistRegistry(); sessions.delete(id);
  try { fs.rmSync(accountAuthDir(id), { recursive: true, force: true }); } catch (_) {}
}
async function sendChatMessage(accountId, target, message) {
  const meta = findMeta(accountId); const run = meta ? getAccount(accountId) : null;
  if (!meta || !run?.connected || !run.sock) throw new Error('A conta selecionada não está conectada.');
  let jid = String(target || '').trim();
  if (/^\+?[0-9][0-9\s().-]{5,20}$/.test(jid)) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
  if (!/@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) throw new Error('Destino de conversa inválido. Selecione um contato, número ou grupo do WhatsApp.');
  const text = String(message || '').trim();
  if (!text) throw new Error('Digite uma mensagem antes de enviar.');
  const min = Math.max(0, Math.min(3600, Number(meta.delayMin ?? 5)));
  const max = Math.max(min, Math.min(3600, Number(meta.delayMax ?? 30)));
  const delaySeconds = min + Math.random() * (max - min);
  if (delaySeconds > 0) await new Promise(resolve => setTimeout(resolve, Math.round(delaySeconds * 1000)));
  const sent = await run.sock.sendMessage(jid, { text });
  const saved = cacheMessage(accountId, { key: sent?.key || { remoteJid: jid, id: crypto.randomUUID(), fromMe: true }, message: sent?.message || { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }, { persist: true, incrementUnread: false });
  return { ok: true, id: sent?.key?.id || saved?.message?.id || '', accountId, jid, delayedSeconds: Math.round(delaySeconds), message: saved?.message || null, chat: saved ? publicChat(saved.chat) : null };
}
async function sendChatMedia(accountId, target, input) {
  const meta = findMeta(accountId); const run = meta ? getAccount(accountId) : null;
  if (!meta || !run?.connected || !run.sock) throw new Error('A conta selecionada não está conectada.');
  let jid = String(target || '').trim();
  if (/^\+?[0-9][0-9\s().-]{5,20}$/.test(jid)) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
  if (!/@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) throw new Error('Destino de conversa inválido. Selecione um contato, número ou grupo do WhatsApp.');
  const mediaType = String(input?.mediaType || '').toLowerCase();
  if (!MEDIA_TYPES.has(mediaType)) throw new Error('Tipo de anexo não suportado. Use imagem, áudio, vídeo ou documento.');
  const encoded = String(input?.data || '');
  if (!encoded || encoded.length > Math.ceil(MAX_OUTBOUND_MEDIA_BYTES * 4 / 3) + 16) throw new Error('O anexo está vazio ou excede o limite de 16 MB.');
  const buffer = Buffer.from(encoded.replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_OUTBOUND_MEDIA_BYTES) throw new Error('O anexo deve ter até 16 MB.');
  const mimeType = String(input?.mimeType || 'application/octet-stream').split(';')[0].trim().slice(0, 150);
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Tipo MIME do arquivo inválido.');
  if (mediaType === 'image' && !mimeType.startsWith('image/')) throw new Error('Selecione um arquivo de imagem válido.');
  if (mediaType === 'video' && !mimeType.startsWith('video/')) throw new Error('Selecione um arquivo de vídeo válido.');
  if (mediaType === 'audio' && !mimeType.startsWith('audio/')) throw new Error('Selecione um arquivo de áudio válido.');
  const fileName = safeMediaName(input?.fileName || (mediaType === 'document' ? 'documento' : `${mediaType}`));
  const caption = String(input?.caption || '').trim().slice(0, 4000);
  const min = Math.max(0, Math.min(3600, Number(meta.delayMin ?? 5)));
  const max = Math.max(min, Math.min(3600, Number(meta.delayMax ?? 30)));
  const delaySeconds = min + Math.random() * (max - min);
  if (delaySeconds > 0) await new Promise(resolve => setTimeout(resolve, Math.round(delaySeconds * 1000)));
  let payload;
  if (mediaType === 'image') payload = { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
  else if (mediaType === 'video') payload = { video: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
  else if (mediaType === 'audio') payload = { audio: buffer, mimetype: mimeType, ptt: false };
  else payload = { document: buffer, mimetype: mimeType, fileName, ...(caption ? { caption } : {}) };
  const sent = await run.sock.sendMessage(jid, payload);
  const messageId = String(sent?.key?.id || crypto.randomUUID());
  const fallbackContent = mediaType === 'image' ? { imageMessage: { caption, mimetype: mimeType } } : mediaType === 'video' ? { videoMessage: { caption, mimetype: mimeType } } : mediaType === 'audio' ? { audioMessage: { mimetype: mimeType } } : { documentMessage: { fileName, caption, mimetype: mimeType } };
  const saved = cacheMessage(accountId, { key: sent?.key || { remoteJid: jid, id: messageId, fromMe: true }, message: sent?.message || fallbackContent, messageTimestamp: Math.floor(Date.now() / 1000) }, { persist: true, incrementUnread: false });
  writeStoredMedia(accountId, messageId, buffer, mimeType, fileName);
  const mediaRun = getAccount(accountId); const mediaChat = mediaRun.chats.get(jid); const stored = mediaChat?.messages?.find(m => String(m.id) === messageId);
  if (stored) { stored.mediaStored = true; stored.mimeType = mimeType; stored.fileName = fileName; stored.mediaSize = buffer.length; persistChatState(accountId); }
  if (mediaType === 'audio' && caption) {
    const textSent = await run.sock.sendMessage(jid, { text: caption });
    cacheMessage(accountId, { key: textSent?.key || { remoteJid: jid, id: crypto.randomUUID(), fromMe: true }, message: textSent?.message || { conversation: caption }, messageTimestamp: Math.floor(Date.now() / 1000) }, { persist: true, incrementUnread: false });
  }
  return { ok: true, id: messageId, accountId, jid, mediaType, fileName, mimeType, delayedSeconds: Math.round(delaySeconds), message: stored || saved?.message || null, chat: saved ? publicChat(saved.chat) : null };
}
async function sendMessage(accountId, phone, message) {
  const number = String(phone || '').replace(/\D/g, '');
  if (!number) throw new Error('Informe um número de telefone com DDI e DDD.');
  return sendChatMessage(accountId, number, message);
}
async function markChatRead(accountId, jid) {
  const meta = findMeta(accountId); const run = meta ? getAccount(accountId) : null;
  if (!meta || !run) throw new Error('Conta não encontrada.');
  const chat = run.chats.get(String(jid || ''));
  if (!chat) throw new Error('Conversa não encontrada no cache sincronizado.');
  const keys = (chat.messages || []).filter(m => !m.fromMe && m.key && m.key.id).slice(-50).map(m => m.key);
  if (run.sock?.readMessages && keys.length) {
    try { await run.sock.readMessages(keys); } catch (e) { logger.debug({ accountId, jid, error: e.message }, 'Could not send read receipt'); }
  }
  chat.unreadCount = 0; persistChatState(accountId);
  return { ok: true, jid, unreadCount: 0 };
}
async function archiveChat(accountId, jid, archived) {
  const meta = findMeta(accountId); const run = meta ? getAccount(accountId) : null;
  if (!meta || !run) throw new Error('Conta não encontrada.');
  const chat = run.chats.get(String(jid || ''));
  if (!chat) throw new Error('Conversa não encontrada no cache sincronizado.');
  if (run.sock?.chatModify) await run.sock.chatModify({ archive: !!archived }, chat.jid);
  chat.archived = !!archived; persistChatState(accountId);
  return { ok: true, jid: chat.jid, archived: chat.archived };
}
function getDefaultAccount() {
  const connected = registry.find(a => getAccount(a.id).connected);
  return connected || registry[0] || null;
}
function asyncRoute(fn) { return (req, res) => Promise.resolve(fn(req, res)).catch(e => { logger.error({ method: req.method, route: req.path, code: e.code || null, error: e.message || 'Falha na solicitação' }, 'API request failed'); res.status(400).json({ error: e.message || 'Falha na solicitação' }); }); }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'H2E CRM WhatsApp Web Bridge', serviceVersion: SERVICE_VERSION, accounts: registry.length }));
app.get('/api/accounts', authorized, (_req, res) => res.json({ accounts: registry.map(publicAccount) }));
app.get('/api/diagnostics', authorized, (_req, res) => {
  function testWritable(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.h2e-check-${process.pid}-${crypto.randomUUID()}`);
      fs.writeFileSync(probe, 'ok', { mode: 0o600 });
      fs.unlinkSync(probe);
      return { ok: true, errorCode: null };
    } catch (e) { return { ok: false, errorCode: e.code || 'UNKNOWN' }; }
  }
  let diskAccounts = null; let fileError = null;
  try { const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); if (Array.isArray(parsed)) diskAccounts = parsed; else fileError = 'INVALID_FORMAT'; }
  catch (e) { fileError = e.code || 'READ_ERROR'; }
  const dataWritable = testWritable(DATA_DIR);
  const sessionsWritable = testWritable(SESSIONS_ROOT);
  const chatStoreWritable = testWritable(CHAT_STORE_DIR);
  const memoryIds = registry.map(a => a.id).sort();
  const diskIds = Array.isArray(diskAccounts) ? diskAccounts.map(a => String(a.id)).sort() : [];
  const storageConsistent = Array.isArray(diskAccounts) && JSON.stringify(memoryIds) === JSON.stringify(diskIds);
  res.json({
    ok: dataWritable.ok && sessionsWritable.ok && chatStoreWritable.ok && storageConsistent,
    serviceVersion: SERVICE_VERSION,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    memoryAccountCount: registry.length,
    storedAccountCount: Array.isArray(diskAccounts) ? diskAccounts.length : null,
    accountsFileExists: fs.existsSync(ACCOUNTS_FILE),
    storageConsistent,
    dataDirectoryWritable: dataWritable.ok,
    dataDirectoryError: dataWritable.errorCode,
    sessionsDirectoryWritable: sessionsWritable.ok,
    sessionsDirectoryError: sessionsWritable.errorCode,
    chatStoreDirectoryWritable: chatStoreWritable.ok,
    chatStoreDirectoryError: chatStoreWritable.errorCode,
    cachedChatCount: [...sessions.values()].reduce((sum, run) => sum + run.chats.size, 0),
    cachedContactCount: [...sessions.values()].reduce((sum, run) => sum + run.contacts.size, 0),
    accountsFileError: fileError,
    bridgeSecretConfigured: Boolean(SECRET),
    wordpressCallbackConfigured: Boolean(WP_INBOUND)
  });
});
app.post('/api/accounts', authorized, asyncRoute(async (req, res) => { const account = await createAccount(req.body?.name); res.status(201).json({ account }); }));
app.get('/api/accounts/:id/chats', authorized, (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  const chats = listChats(req.params.id);
  res.json({ accountId: req.params.id, chats, historySyncEnabled: true, chatCount: chats.length });
});
app.get('/api/accounts/:id/messages', authorized, (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'Informe o parâmetro jid da conversa.' });
  const result = getChatMessages(req.params.id, jid);
  if (!result.chat) return res.status(404).json({ error: 'Conversa ainda não aparece no cache sincronizado. Aguarde a sincronização de chats/contatos do WhatsApp.' });
  res.json(result);
});
app.get('/api/accounts/:id/media/:messageId', authorized, (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  const messageId = String(req.params.messageId || '');
  if (!messageId || !/^[A-Za-z0-9_-]{6,200}$/.test(messageId)) return res.status(400).json({ error: 'ID de mídia inválido.' });
  const run = getAccount(req.params.id);
  let found = null;
  for (const chat of run.chats.values()) {
    found = (chat.messages || []).find(m => String(m.id) === messageId && m.mediaStored);
    if (found) break;
  }
  if (!found) return res.status(404).json({ error: 'O anexo ainda não foi baixado ou não está disponível no cache.' });
  const file = mediaDiskPath(req.params.id, messageId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'O arquivo de mídia não está presente no armazenamento local.' });
  let mime = String(found.mimeType || 'application/octet-stream').split(';')[0].replace(/[\r\n]/g, '').toLowerCase() || 'application/octet-stream';
  const safeMimes = new Set(['image/jpeg','image/png','image/gif','image/webp','audio/ogg','audio/opus','audio/mpeg','audio/mp4','audio/amr','audio/wav','audio/webm','video/mp4','video/3gpp','video/quicktime','application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/zip','application/rtf','text/plain','text/csv','application/octet-stream']);
  if (!safeMimes.has(mime)) mime = 'application/octet-stream';
  const name = safeMediaName(found.fileName || 'arquivo');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).on('error', err => { logger.warn({ accountId: req.params.id, error: err.message }, 'Unable to stream media'); if (!res.headersSent) res.status(500).end(); }).pipe(res);
});
app.post('/api/accounts/:id/media', authorized, asyncRoute(async (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  res.json(await sendChatMedia(req.params.id, req.body?.jid, req.body || {}));
}));
app.post('/api/accounts/:id/messages', authorized, asyncRoute(async (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  res.json(await sendChatMessage(req.params.id, req.body?.jid || req.body?.phone, req.body?.text || req.body?.message));
}));
app.post('/api/accounts/:id/chats/read', authorized, asyncRoute(async (req, res) => res.json(await markChatRead(req.params.id, req.body?.jid))));
app.post('/api/accounts/:id/chats/archive', authorized, asyncRoute(async (req, res) => res.json(await archiveChat(req.params.id, req.body?.jid, req.body?.archived))));
app.get('/api/accounts/:id/status', authorized, (req, res) => {
  const meta = findMeta(req.params.id); if (!meta) return res.status(404).json({ error: 'Conta não encontrada' });
  res.json(publicAccount(meta));
});
app.get('/api/accounts/:id/qr', authorized, (req, res) => {
  const meta = findMeta(req.params.id); if (!meta) return res.status(404).json({ error: 'Conta não encontrada' });
  const run = getAccount(meta.id); res.json({ connected: run.connected, qr: run.qr, lastError: run.lastError });
});
app.post('/api/accounts/:id/connect', authorized, asyncRoute(async (req, res) => {
  if (!findMeta(req.params.id)) return res.status(404).json({ error: 'Conta não encontrada' });
  await startAccount(req.params.id); res.json(publicAccount(findMeta(req.params.id)));
}));
app.post('/api/accounts/:id/settings', authorized, asyncRoute(async (req, res) => {
  const meta = findMeta(req.params.id); if (!meta) return res.status(404).json({ error: 'Conta não encontrada' });
  const min = Number(req.body?.delayMin ?? meta.delayMin ?? 5);
  const max = Number(req.body?.delayMax ?? meta.delayMax ?? 30);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 3600) throw new Error('Informe um intervalo de atraso válido entre 0 e 3600 segundos.');
  const proxy = cleanProxy(req.body?.proxyUrl ?? meta.proxyUrl ?? '');
  meta.delayMin = Math.round(min); meta.delayMax = Math.round(max); meta.proxyUrl = proxy;
  persistRegistry(); res.json({ ok: true, account: publicAccount(meta), note: 'O atraso foi salvo. Se configurar proxy, ele será aplicado na próxima conexão da conta.' });
}));
app.delete('/api/accounts/:id', authorized, asyncRoute(async (req, res) => { await removeAccount(req.params.id); res.json({ ok: true }); }));
app.post('/api/accounts/:id/send', authorized, asyncRoute(async (req, res) => {
  const result = await sendMessage(req.params.id, req.body?.phone, req.body?.message); res.json(result);
}));
// Backwards-compatible endpoints for the previous single-account bridge.
app.get('/api/status', authorized, (_req, res) => { const meta = getDefaultAccount(); if (!meta) return res.json({ connected:false, connecting:false, hasQr:false, phone:'', lastError:'Nenhuma conta cadastrada' }); res.json(publicAccount(meta)); });
app.get('/api/qr', authorized, (_req, res) => { const meta = getDefaultAccount(); const run = meta ? getAccount(meta.id) : null; res.json({ connected:!!run?.connected, qr:run?.qr || '', lastError:run?.lastError || 'Nenhuma conta cadastrada' }); });
app.post('/api/connect', authorized, asyncRoute(async (_req, res) => { let meta = getDefaultAccount(); if (!meta) meta = await createAccount('Conta principal'); await startAccount(meta.id); res.json({ ok:true, ...publicAccount(meta) }); }));
app.post('/api/logout', authorized, asyncRoute(async (_req, res) => { const meta = getDefaultAccount(); if (meta) await removeAccount(meta.id); res.json({ ok:true }); }));
app.post('/api/send', authorized, asyncRoute(async (req, res) => {
  const selected = req.body?.accountId || getDefaultAccount()?.id;
  if (!selected) return res.status(409).json({ error:'Nenhuma conta WhatsApp cadastrada' });
  const result = await sendMessage(selected, req.body?.phone, req.body?.message); res.json(result);
}));

async function boot() {
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(SESSIONS_ROOT, { recursive: true }); fs.mkdirSync(CHAT_STORE_DIR, { recursive: true }); fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const accountStoreExisted = fs.existsSync(ACCOUNTS_FILE);
  try { const read = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); if (Array.isArray(read)) registry = read.map(normalizeMeta); }
  catch (_) { registry = []; }
  if (!registry.length && !accountStoreExisted) {
    registry = [normalizeMeta({ id:'principal', name:'Conta principal', delayMin:5, delayMax:30, proxyUrl:'' })];
    persistRegistry();
  }
  migrateLegacySession();
  for (const meta of registry) {
    getAccount(meta.id);
    startAccount(meta.id).catch(err => logger.warn({ accountId:meta.id, err:err.message }, 'Initial account start failed'));
  }
  app.listen(PORT, HOST, () => logger.info({ serviceVersion: SERVICE_VERSION, nodeVersion: process.versions.node, accountCount: registry.length }, `H2E multi-account bridge listening on ${HOST}:${PORT}`));
}
boot().catch(err => { logger.error({ err:err.message }, 'Bridge startup failed'); process.exit(1); });
