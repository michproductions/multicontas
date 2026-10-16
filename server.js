require('dotenv').config();
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SECRET = process.env.BRIDGE_SECRET || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './h2e-whatsapp-data');
const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR || path.join(DATA_DIR, 'sessions'));
const LEGACY_AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const WP_INBOUND = process.env.WORDPRESS_INBOUND_URL || '';
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sessions = new Map();
let registry = [];

function authorized(req, res, next) {
  if (!SECRET || req.get('x-h2e-secret') !== SECRET) return res.status(401).json({ error: 'Não autorizado' });
  next();
}
function textFromMessage(m) {
  const msg = m.message || {};
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || msg.buttonsResponseMessage?.selectedDisplayText || msg.listResponseMessage?.title || '';
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
}
function findMeta(id) { return registry.find(a => a.id === id); }
function getAccount(id) {
  const meta = findMeta(id);
  if (!meta) return null;
  let runtime = sessions.get(id);
  if (!runtime) {
    runtime = { id, sock: null, qr: '', connected: false, connecting: false, lastError: '', phone: '', startPromise: null, intentionalClose: false };
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
      let version;
      try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { version = undefined; }
      const agent = proxyAgent(meta.proxyUrl);
      const sock = makeWASocket({
        auth: state, version, logger, printQRInTerminal: false,
        browser: ['H2E CRM WhatsApp', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false, syncFullHistory: false,
        ...(agent ? { agent, fetchAgent: agent } : {})
      });
      run.sock = sock;
      sock.ev.on('creds.update', saveCreds);
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
          if (run.intentionalClose) { run.intentionalClose = false; run.startPromise = null; return; }
          const code = lastDisconnect?.error?.output?.statusCode;
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
        if (type !== 'notify') return;
        for (const m of messages || []) {
          if (!m.message || m.key?.fromMe || m.key?.remoteJid?.endsWith('@g.us') || m.key?.remoteJid === 'status@broadcast') continue;
          const from = (m.key.remoteJid || '').split('@')[0].split(':')[0];
          const body = textFromMessage(m);
          if (!from || !body) continue;
          await notifyWordPress({
            event: 'message', accountId: id, accountName: meta.name, from,
            name: m.pushName || from, text: body, id: m.key.id || '',
            timestamp: m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now()/1000), type: 'text'
          });
        }
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
  const meta = normalizeMeta({ id: crypto.randomUUID(), name: safeName, delayMin: 5, delayMax: 30, proxyUrl: '' });
  registry.push(meta); persistRegistry(); getAccount(meta.id);
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
async function sendMessage(accountId, phone, message) {
  const meta = findMeta(accountId); const run = meta ? getAccount(accountId) : null;
  if (!meta || !run?.connected || !run.sock) throw new Error('A conta selecionada não está conectada.');
  const number = String(phone || '').replace(/\D/g, '');
  const text = String(message || '').trim();
  if (!number || !text) throw new Error('Telefone e mensagem são obrigatórios.');
  const min = Math.max(0, Math.min(3600, Number(meta.delayMin ?? 5)));
  const max = Math.max(min, Math.min(3600, Number(meta.delayMax ?? 30)));
  const delaySeconds = min + Math.random() * (max - min);
  if (delaySeconds > 0) await new Promise(resolve => setTimeout(resolve, Math.round(delaySeconds * 1000)));
  const jid = number + '@s.whatsapp.net';
  const sent = await run.sock.sendMessage(jid, { text });
  return { ok: true, id: sent?.key?.id || '', accountId, delayedSeconds: Math.round(delaySeconds) };
}
function getDefaultAccount() {
  const connected = registry.find(a => getAccount(a.id).connected);
  return connected || registry[0] || null;
}
function asyncRoute(fn) { return (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message || 'Falha na solicitação' })); }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'H2E CRM WhatsApp Web Bridge', accounts: registry.length }));
app.get('/api/accounts', authorized, (_req, res) => res.json({ accounts: registry.map(publicAccount) }));
app.post('/api/accounts', authorized, asyncRoute(async (req, res) => { const account = await createAccount(req.body?.name); res.status(201).json({ account }); }));
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
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
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
  app.listen(PORT, HOST, () => logger.info(`H2E multi-account bridge listening on ${HOST}:${PORT}`));
}
boot().catch(err => { logger.error({ err:err.message }, 'Bridge startup failed'); process.exit(1); });
