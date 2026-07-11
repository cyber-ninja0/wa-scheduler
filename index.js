require('dotenv').config();
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) console.warn('ADMIN_KEY is empty; set it in .env, otherwise all protected endpoints will reject requests.');

let ENC_KEY = null;
if (process.env.ENCRYPTION_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
  ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  console.log('Encryption: ENABLED (AES-256-GCM)');
} else {
  console.log('Encryption: disabled (set ENCRYPTION_KEY to 64 hex chars to enable).');
}

function encryptBody(plain) {
  if (!ENC_KEY) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptBody(b64) {
  if (!ENC_KEY) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null;
  }
}

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  body TEXT,
  body_enc TEXT,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  repeat_type TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_status_time ON scheduled_messages(status, send_at);
`);

db.prepare(`UPDATE scheduled_messages SET status='pending' WHERE status='processing'`).run();

let sock = null;
let ready = false;
let reconnectTimer = null;

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log('Baileys WA version', version.join('.'), `(latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
    syncFullHistory: false,
    browser: ['WA Scheduler', 'Chrome', '1.2'],
    markOnlineOnConnect: false
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Scan this QR to login:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      ready = true;
      console.log('WhatsApp connection OPEN');
    } else if (connection === 'close') {
      ready = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed', code, lastDisconnect?.error?.message);
      if (code === DisconnectReason.loggedOut) {
        console.error('Logged out. Delete the "auth" folder and restart to re-pair.');
        return;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWA().catch(console.error);
      }, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}
startWA().catch(console.error);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authCheck(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!ADMIN_KEY || !safeEqual(token, ADMIN_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function toEpoch(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(input);
  if (typeof input === 'string') {
    const ms = new Date(input).getTime();
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

function normalizeToE164(to) {
  if (!/^\+\d{8,15}$/.test(to)) return null;
  return to;
}

function toJidFromE164(e164) {
  const digits = e164.replace(/\D/g, '');
  return jidNormalizedUser(`${digits}@s.whatsapp.net`);
}

const REPEAT_SECONDS = { daily: 24 * 3600, weekly: 7 * 24 * 3600 };
let dispatching = false;

async function dispatchDue() {
  if (dispatching || !ready || !sock) return;
  dispatching = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`
      SELECT id, recipient, body, body_enc, send_at, repeat_type
      FROM scheduled_messages
      WHERE status = 'pending' AND send_at <= ?
      ORDER BY send_at ASC
      LIMIT 20
    `).all(now);
    if (!rows.length) return;

    const claim = db.prepare(`UPDATE scheduled_messages SET status='processing' WHERE id=? AND status='pending'`);
    const markSent = db.prepare(`UPDATE scheduled_messages SET status='sent', last_error=NULL WHERE id=?`);
    const markRepeat = db.prepare(`UPDATE scheduled_messages SET send_at=?, status='pending', last_error=NULL WHERE id=?`);
    const markFailed = db.prepare(`UPDATE scheduled_messages SET status='failed', last_error=? WHERE id=?`);

    for (const row of rows) {
      if (claim.run(row.id).changes === 0) continue;

      let text = row.body;
      if (!text && row.body_enc) text = decryptBody(row.body_enc);
      if (!text) {
        markFailed.run('Message body unavailable (missing or wrong ENCRYPTION_KEY).', row.id);
        continue;
      }

      try {
        const jid = toJidFromE164(row.recipient);
        await sock.sendMessage(jid, { text });
        const interval = REPEAT_SECONDS[row.repeat_type];
        if (interval) {
          let next = row.send_at + interval;
          const current = Math.floor(Date.now() / 1000);
          while (next <= current) next += interval;
          markRepeat.run(next, row.id);
        } else {
          markSent.run(row.id);
        }
        console.log(`Sent ${row.id} to ${row.recipient}`);
      } catch (e) {
        markFailed.run(String(e?.message || e), row.id);
        console.error(`Failed to send ${row.id}:`, e?.message || e);
      }
    }
  } finally {
    dispatching = false;
  }
}
setInterval(dispatchDue, 10 * 1000);

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/ui', express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, ready, connected: !!sock });
});

app.get('/messages', (req, res) => {
  if (!authCheck(req, res)) return;
  const rows = db.prepare(`
    SELECT id, recipient, body,
           (CASE WHEN body_enc IS NOT NULL THEN 1 ELSE 0 END) AS encrypted,
           send_at, status, repeat_type, created_at, last_error
    FROM scheduled_messages
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

app.post('/schedule', (req, res) => {
  if (!authCheck(req, res)) return;
  const { to, body, send_at_iso, send_at_epoch, repeat = 'none' } = req.body || {};

  const e164 = normalizeToE164(String(to || ''));
  if (!e164) return res.status(400).json({ error: "Invalid 'to' phone. Use E.164 like +15551234567." });

  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return res.status(400).json({ error: "Empty 'body'." });
  if (text.length > 4096) return res.status(400).json({ error: "Body too long (max 4096 chars)." });

  const now = Math.floor(Date.now() / 1000);
  const sendAt = toEpoch(send_at_epoch ?? send_at_iso);
  if (!sendAt || sendAt <= now) {
    return res.status(400).json({ error: 'Time must be in the future (ISO with timezone or epoch seconds).' });
  }

  const repeatType = ['none', 'daily', 'weekly'].includes(repeat) ? repeat : 'none';
  const id = crypto.randomUUID();

  let storePlain = text;
  let storeEnc = null;
  if (ENC_KEY) {
    storeEnc = encryptBody(text);
    storePlain = null;
  }

  db.prepare(`
    INSERT INTO scheduled_messages (id, recipient, body, body_enc, send_at, status, repeat_type, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, e164, storePlain, storeEnc, sendAt, repeatType, now);

  res.json({ ok: true, id, to: e164, send_at: sendAt, repeat: repeatType });
});

app.post('/cancel', (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Provide 'id'." });
  const info = db.prepare(`SELECT status FROM scheduled_messages WHERE id=?`).get(id);
  if (!info) return res.status(404).json({ error: 'Not found' });
  const result = db.prepare(`UPDATE scheduled_messages SET status='cancelled', last_error=NULL WHERE id=? AND status='pending'`).run(id);
  if (result.changes === 0) return res.status(400).json({ error: 'Only pending messages can be cancelled' });
  res.json({ ok: true, id, status: 'cancelled' });
});

app.post('/reschedule', (req, res) => {
  if (!authCheck(req, res)) return;
  const { id, new_send_at_iso, new_send_at_epoch } = req.body || {};
  if (!id) return res.status(400).json({ error: "Provide 'id'." });
  const info = db.prepare(`SELECT status FROM scheduled_messages WHERE id=?`).get(id);
  if (!info) return res.status(404).json({ error: 'Not found' });
  if (info.status === 'processing') return res.status(409).json({ error: 'Message is being sent right now' });
  const newAt = toEpoch(new_send_at_epoch ?? new_send_at_iso);
  if (!newAt || newAt <= Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: 'Time must be in the future.' });
  }
  db.prepare(`UPDATE scheduled_messages SET send_at=?, status='pending', last_error=NULL WHERE id=?`).run(newAt, id);
  res.json({ ok: true, id, send_at: newAt });
});

app.listen(PORT, HOST, () => {
  console.log(`WA Scheduler listening on http://${HOST}:${PORT}`);
  console.log(`UI: http://<host>:${PORT}/ui`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
