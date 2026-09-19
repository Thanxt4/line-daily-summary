require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS || 'gemini-1.5-flash,gemini-1.0-pro')
  .split(',').map(m => m.trim()).filter(Boolean);
const GEMINI_MODEL_CHAIN = [GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS.filter(m => m !== GEMINI_MODEL)];

const TZ_OFFSET_HOURS = 7;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'itail-insight-secret-change-me';

// ---------- Database ----------
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, 'data.db'));

const IMAGES_DIR = path.join(DB_DIR, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    user_id TEXT,
    display_name TEXT,
    text TEXT,
    ts INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_group_date ON messages(group_id, date);

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT,
    message_count INTEGER,
    created_at INTEGER,
    image_refs TEXT,
    UNIQUE(group_id, date)
  );

  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    group_name TEXT
  );

  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_images_group_date ON images(group_id, date);

  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    updated_at INTEGER
  );

  -- App accounts (multi-user login)
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER
  );

  -- Access control: which account can see which LINE group
  CREATE TABLE IF NOT EXISTS account_group_access (
    account_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    PRIMARY KEY (account_id, group_id)
  );

  -- Prompt settings (admin configurable)
  CREATE TABLE IF NOT EXISTS prompt_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER
  );

  -- Acknowledgement: per-topic per-user acknowledgement
  CREATE TABLE IF NOT EXISTS acknowledgements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id INTEGER NOT NULL,
    topic_index INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    acked_at INTEGER NOT NULL,
    UNIQUE(summary_id, topic_index, account_id)
  );
`);

// Migrations
['image_refs'].forEach(col => {
  try { db.exec(`ALTER TABLE summaries ADD COLUMN ${col} TEXT`); } catch(e){}
});

// Seed default prompt settings
const DEFAULT_PROMPT_INTRO = `คุณคือผู้ช่วยสรุปบทสนทนากลุ่มไลน์ระดับมืออาชีพในองค์กรอุตสาหกรรม`;
const DEFAULT_PROMPT_RULES = `- ใช้ภาษาไทยทางการในระดับรายงานธุรกิจ ห้ามใช้ภาษาพูด คำย่อแบบแชท หรือภาษาสแลง\n- เขียนให้ครบถ้วนและชัดเจน คนที่ไม่ได้อยู่ในบทสนทนาต้องเข้าใจได้ทันที\n- รวมประเด็นเดียวกันเป็นหัวข้อเดียว ไม่แยกซ้ำ`;
const DEFAULT_PROMPT_HOW = `**บังคับเขียนแบบ numbered list เท่านั้น** แต่ละขั้นตอนขึ้นบรรทัดใหม่ รูปแบบ: "1. [ขั้นตอน]\n2. [ขั้นตอน]\n3. [ขั้นตอน]" ห้ามเขียนเป็น paragraph ยาวติดกัน ต้องมีอย่างน้อย 2 ข้อ แต่ละข้อเป็นประโยคภาษาทางการ`;

function getPromptSetting(key, defaultVal) {
  const row = db.prepare('SELECT value FROM prompt_settings WHERE key=?').get(key);
  return row ? row.value : defaultVal;
}
function setPromptSetting(key, value) {
  db.prepare('INSERT INTO prompt_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run(key, value, Date.now());
}

// Seed defaults if not set
[
  ['prompt_intro', DEFAULT_PROMPT_INTRO],
  ['prompt_rules', DEFAULT_PROMPT_RULES],
  ['prompt_how', DEFAULT_PROMPT_HOW],
].forEach(([k, v]) => { if (!db.prepare('SELECT key FROM prompt_settings WHERE key=?').get(k)) setPromptSetting(k, v); });

// Seed default admin account if not exists
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'itail-salt').digest('hex');
}
const existingAdmin = db.prepare('SELECT id FROM accounts WHERE username = ?').get(ADMIN_USERNAME);
if (!existingAdmin) {
  db.prepare(
    `INSERT INTO accounts (username, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, 1, ?)`
  ).run(ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), 'Administrator', Date.now());
  console.log(`[init] สร้าง admin account: ${ADMIN_USERNAME}`);
}

// ---------- Helpers ----------
function thaiDateString(tsMillis) {
  const d = new Date(tsMillis + TZ_OFFSET_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const PLACEHOLDER_NAME_RE = /^สมาชิก-[a-zA-Z0-9]{4}$/;

function getCachedDisplayName(userId) {
  if (!userId) return null;
  const row = db.prepare(`SELECT display_name FROM users WHERE user_id = ?`).get(userId);
  return row?.display_name || null;
}

function cacheDisplayName(userId, displayName) {
  if (!userId || !displayName || PLACEHOLDER_NAME_RE.test(displayName)) return;
  db.prepare(
    `INSERT INTO users (user_id, display_name, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`
  ).run(userId, displayName, Date.now());
}

async function getDisplayName(groupId, userId) {
  if (!userId) return 'สมาชิกในกลุ่ม';
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.displayName) { cacheDisplayName(userId, data.displayName); return data.displayName; }
    }
  } catch(e) { console.error('[getDisplayName]', e.message); }
  return getCachedDisplayName(userId) || `สมาชิก-${userId.slice(-4)}`;
}

async function getGroupSummary(groupId) {
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) { return null; }
}

async function ensureGroupName(groupId) {
  const existing = db.prepare(`SELECT group_id, group_name FROM groups WHERE group_id = ?`).get(groupId);
  if (!existing || existing.group_name === groupId) {
    const summary = await getGroupSummary(groupId);
    if (summary?.groupName) {
      db.prepare(`INSERT INTO groups (group_id, group_name) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET group_name=excluded.group_name`)
        .run(groupId, summary.groupName);
    } else if (!existing) {
      db.prepare(`INSERT OR IGNORE INTO groups (group_id, group_name) VALUES (?,?)`).run(groupId, groupId);
    }
  }
}

async function callGeminiWithFallback(parts) {
  let lastError = null;
  for (let i = 0; i < GEMINI_MODEL_CHAIN.length; i++) {
    const model = GEMINI_MODEL_CHAIN[i];
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json' } })
        }
      );
      if (resp.ok) return await resp.json();
      const errText = await resp.text();
      lastError = new Error(`Gemini API error (${model}): ${resp.status} ${errText}`);
      if (resp.status === 429 && i < GEMINI_MODEL_CHAIN.length - 1) continue;
      throw lastError;
    } catch(e) {
      lastError = e;
      if (i === GEMINI_MODEL_CHAIN.length - 1) throw lastError;
    }
  }
  throw lastError;
}

async function summarizeDate(groupId, dateStr) {
  const rows = db.prepare(`SELECT display_name, text FROM messages WHERE group_id=? AND date=? ORDER BY ts ASC`).all(groupId, dateStr);
  if (rows.length === 0) return null;

  const conversation = rows.map(r => `${r.display_name || 'ไม่ทราบชื่อ'}: ${r.text}`).join('\n');

  const promptIntro = getPromptSetting('prompt_intro', DEFAULT_PROMPT_INTRO);
  const promptRules = getPromptSetting('prompt_rules', DEFAULT_PROMPT_RULES);
  const promptHow = getPromptSetting('prompt_how', DEFAULT_PROMPT_HOW);

  const promptText = `${promptIntro}

บทสนทนาต่อไปนี้มาจากกลุ่มไลน์งาน วันที่ ${dateStr}
(ข้อความที่ขึ้นต้นด้วย [ส่งรูปภาพ: xxx] คือตำแหน่งที่มีการส่งรูปภาพ)

--- บทสนทนา ---
${conversation}
--- สิ้นสุดบทสนทนา ---

**ภารกิจ:** วิเคราะห์และสรุปประเด็นสำคัญทั้งหมดตามหลัก 5W1H

**กฎการเขียนที่เคร่งครัด:**
${promptRules}

**รายละเอียดแต่ละ field:**
- **what**: ชื่อประเด็น/เหตุการณ์ที่เกิดขึ้น (ประโยคกริยานามที่กระชับ)
- **who**: รายชื่อบุคคล/ทีม/แผนกที่เกี่ยวข้องทั้งหมด คั่นด้วยจุลภาค
- **when**: วันที่/เวลาที่เกิดเหตุการณ์จริงในบทสนทนา (ไม่ใช่เวลาที่ส่งข้อความ) ถ้าระบุว่า "คืนนี้" หรือ "วันนี้" ให้ใช้ ${dateStr}
- **where**: สถานที่/เครื่องจักร/ไลน์การผลิต/ห้องปฏิบัติการที่เกี่ยวข้อง
- **why**: สาเหตุหรือวัตถุประสงค์ที่ทำให้เกิดกิจกรรมนี้
- **how**: ${promptHow}

หากไม่มีข้อมูลในช่องใด ให้ใส่ "ไม่ระบุ"
หากไม่มีสาระสำคัญทั้งวัน ให้ topics เป็น []

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{"topics": [{"what": "...", "who": "...", "when": "...", "where": "...", "why": "...", "how": "..."}]}`;

  const parts = [{ text: promptText }];
  const data = await callGeminiWithFallback(parts);
  const rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();

  let summaryText = JSON.stringify({ topics: [] });
  try {
    const parsed = JSON.parse(rawText);
    summaryText = JSON.stringify({ topics: Array.isArray(parsed.topics) ? parsed.topics : [] });
  } catch(e) {
    summaryText = JSON.stringify({ topics: [], raw: rawText });
  }

  // Collect image refs for this date
  const imageRows = db.prepare(`SELECT message_id FROM images WHERE group_id=? AND date=? ORDER BY ts ASC`).all(groupId, dateStr);
  const imageRefs = imageRows.map(r => ({ message_id: r.message_id }));

  db.prepare(
    `INSERT INTO summaries (group_id, date, summary, message_count, created_at, image_refs) VALUES (?,?,?,?,?,?)
     ON CONFLICT(group_id, date) DO UPDATE SET summary=excluded.summary, message_count=excluded.message_count, created_at=excluded.created_at, image_refs=excluded.image_refs`
  ).run(groupId, dateStr, summaryText, rows.length, Date.now(), JSON.stringify(imageRefs));

  return summaryText;
}

// ---------- LINE Webhook ----------
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(req.body).digest('base64');
  if (!signature || hash !== signature) return res.status(401).send('invalid signature');
  res.status(200).send('OK');

  let body;
  try { body = JSON.parse(req.body.toString()); } catch(e) { return; }

  for (const event of body.events || []) {
    try {
      if (event.type === 'message' && event.source?.type === 'group') {
        const groupId = event.source.groupId;
        const userId = event.source.userId;
        const ts = event.timestamp;
        const dateStr = thaiDateString(ts);

        if (event.message?.type === 'text') {
          const text = event.message.text;
          const displayName = await getDisplayName(groupId, userId);
          db.prepare(`INSERT INTO messages (group_id, user_id, display_name, text, ts, date) VALUES (?,?,?,?,?,?)`)
            .run(groupId, userId, displayName, text, ts, dateStr);
          await ensureGroupName(groupId);
        } else if (event.message?.type === 'image') {
          const messageId = event.message.id;
          const displayName = await getDisplayName(groupId, userId);
          db.prepare(`INSERT INTO messages (group_id, user_id, display_name, text, ts, date) VALUES (?,?,?,?,?,?)`)
            .run(groupId, userId, displayName, `[ส่งรูปภาพ: ${messageId}]`, ts, dateStr);
          try {
            const contentResp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
              headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
            });
            if (contentResp.ok) {
              const buffer = Buffer.from(await contentResp.arrayBuffer());
              fs.writeFileSync(path.join(IMAGES_DIR, `${messageId}.jpg`), buffer);
              db.prepare(`INSERT INTO images (group_id, message_id, ts, date) VALUES (?,?,?,?)`).run(groupId, messageId, ts, dateStr);
            }
          } catch(err) { console.error('[image]', err.message); }
          await ensureGroupName(groupId);
        }
      }
    } catch(err) { console.error('[webhook] error', err); }
  }
});

// ---------- Express Setup ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

// ---------- Auth ----------
app.get('/login', (req, res) => {
  if (req.session?.accountId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
  if (account && account.password_hash === hashPassword(password)) {
    req.session.accountId = account.id;
    req.session.username = account.username;
    req.session.displayName = account.display_name;
    req.session.isAdmin = account.is_admin === 1;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

function requireAuth(req, res, next) {
  if (req.session?.accountId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(403).json({ error: 'forbidden: admin only' });
}

app.get('/api/session', (req, res) => {
  res.json({
    loggedIn: !!req.session?.accountId,
    username: req.session?.username || null,
    displayName: req.session?.displayName || null,
    isAdmin: req.session?.isAdmin || false,
    accountId: req.session?.accountId || null
  });
});

app.use(requireAuth);

// ---------- Media ----------
app.get('/media/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_-]+\.jpg$/.test(filename)) return res.status(400).send('invalid filename');
  const filePath = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  res.sendFile(filePath);
});

// ---------- Groups API ----------
app.get('/api/groups', (req, res) => {
  let rows;
  if (req.session.isAdmin) {
    rows = db.prepare(`SELECT group_id, group_name FROM groups ORDER BY group_name`).all();
  } else {
    rows = db.prepare(`
      SELECT g.group_id, g.group_name FROM groups g
      INNER JOIN account_group_access a ON a.group_id = g.group_id
      WHERE a.account_id = ?
      ORDER BY g.group_name
    `).all(req.session.accountId);
  }
  res.json(rows);
});

// ---------- Summaries API ----------
app.get('/api/summaries', (req, res) => {
  const { group_id, from, to } = req.query;
  const isValidDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const fromDate = isValidDate(from) ? from : null;
  const toDate = isValidDate(to) ? to : null;

  // Check access
  if (!req.session.isAdmin && group_id) {
    const access = db.prepare('SELECT 1 FROM account_group_access WHERE account_id=? AND group_id=?').get(req.session.accountId, group_id);
    if (!access) return res.status(403).json({ error: 'no access to this group' });
  }

  const conditions = [];
  const params = [];
  if (group_id) { conditions.push('group_id=?'); params.push(group_id); }
  if (fromDate) { conditions.push('date>=?'); params.push(fromDate); }
  if (toDate) { conditions.push('date<=?'); params.push(toDate); }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM summaries ${whereClause} ORDER BY date DESC`).all(...params);

  const withImages = rows.map(r => {
    let images = [];
    try { images = r.image_refs ? JSON.parse(r.image_refs) : []; } catch(e) {}
    return { ...r, images: images.map(img => ({ ...img, url: `/media/${img.message_id}.jpg` })) };
  });
  res.json(withImages);
});

// ---------- All-groups summary (for "ภาพรวมทั้งหมด") ----------
app.get('/api/summaries/all', (req, res) => {
  const { from, to, who, where: whereFilter } = req.query;
  const isValidDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const fromDate = isValidDate(from) ? from : null;
  const toDate = isValidDate(to) ? to : null;

  // All users (admin and regular) see all groups they have access to
  let groupCond = '';
  let groupParams = [];
  if (!req.session.isAdmin) {
    const accessRows = db.prepare('SELECT group_id FROM account_group_access WHERE account_id=?').all(req.session.accountId);
    if (accessRows.length === 0) return res.json([]);
    const gids = accessRows.map(r => r.group_id);
    groupCond = `AND s.group_id IN (${gids.map(() => '?').join(',')})`;
    groupParams = gids;
  }

  const conditions = [`1=1`];
  const params = [...groupParams];
  if (fromDate) { conditions.push('s.date>=?'); params.push(fromDate); }
  if (toDate) { conditions.push('s.date<=?'); params.push(toDate); }

  const rows = db.prepare(`
    SELECT s.*, g.group_name FROM summaries s
    LEFT JOIN groups g ON g.group_id = s.group_id
    WHERE ${conditions.join(' AND ')} ${groupCond}
    ORDER BY s.date DESC
  `).all(...params);

  let result = rows.map(r => {
    let images = [];
    try { images = r.image_refs ? JSON.parse(r.image_refs) : []; } catch(e) {}
    return { ...r, images: images.map(img => ({ ...img, url: `/media/${img.message_id}.jpg` })) };
  });

  // Filter by who
  if (who && who.trim()) {
    const whoLower = who.toLowerCase();
    result = result.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.summary); } catch(e) {}
      if (!parsed?.topics) return null;
      const filtered = parsed.topics.filter(t => (t.who || '').toLowerCase().includes(whoLower));
      if (filtered.length === 0) return null;
      return { ...r, summary: JSON.stringify({ topics: filtered }) };
    }).filter(Boolean);
  }

  // Filter by where
  if (whereFilter && whereFilter.trim()) {
    const whereLower = whereFilter.toLowerCase();
    result = result.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.summary); } catch(e) {}
      if (!parsed?.topics) return null;
      const filtered = parsed.topics.filter(t => (t.where || '').toLowerCase().includes(whereLower));
      if (filtered.length === 0) return null;
      return { ...r, summary: JSON.stringify({ topics: filtered }) };
    }).filter(Boolean);
  }

  res.json(result);
});

// ---------- Summarize Now ----------
app.post('/api/summarize-now', async (req, res) => {
  try {
    const { group_id, date } = req.body;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });
    const dateStr = date || thaiDateString(Date.now());
    const summary = await summarizeDate(group_id, dateStr);
    if (summary === null) return res.status(404).json({ error: 'ไม่มีข้อความในวันนี้สำหรับกลุ่มนี้' });
    res.json({ date: dateStr, summary });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Fix Names ----------
app.post('/api/fix-names', async (req, res) => {
  try {
    const { group_id, resummarize } = req.body;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });
    const placeholderRows = db.prepare(`SELECT DISTINCT user_id FROM messages WHERE group_id=? AND user_id IS NOT NULL AND display_name LIKE 'สมาชิก-%'`).all(group_id);
    const fixed = [], stillUnresolved = [];
    for (const row of placeholderRows) {
      const userId = row.user_id;
      let newName = null;
      try {
        const resp = await fetch(`https://api.line.me/v2/bot/group/${group_id}/member/${userId}`, {
          headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (resp.ok) { const d = await resp.json(); if (d.displayName) newName = d.displayName; }
      } catch(e) {}
      if (newName) {
        db.prepare(`UPDATE messages SET display_name=? WHERE group_id=? AND user_id=? AND display_name LIKE 'สมาชิก-%'`).run(newName, group_id, userId);
        cacheDisplayName(userId, newName);
        fixed.push({ user_id: userId, display_name: newName });
      } else { stillUnresolved.push(userId); }
    }
    let resummarizedDates = [];
    if (resummarize && fixed.length > 0) {
      const dateRows = db.prepare(`SELECT DISTINCT date FROM messages WHERE group_id=? AND user_id IN (${fixed.map(() => '?').join(',')})`).all(group_id, ...fixed.map(f => f.user_id));
      for (const d of dateRows) {
        try { await summarizeDate(group_id, d.date); resummarizedDates.push(d.date); } catch(err) {}
      }
    }
    res.json({ fixed, still_unresolved: stillUnresolved, resummarized_dates: resummarizedDates });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Acknowledgement API ----------
app.post('/api/ack', (req, res) => {
  const { summary_id, topic_index } = req.body;
  if (summary_id === undefined || topic_index === undefined) return res.status(400).json({ error: 'summary_id and topic_index required' });
  const accountId = req.session.accountId;
  try {
    db.prepare(`INSERT OR REPLACE INTO acknowledgements (summary_id, topic_index, account_id, acked_at) VALUES (?,?,?,?)`)
      .run(summary_id, topic_index, accountId, Date.now());
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ack', (req, res) => {
  const { summary_id, topic_index } = req.body;
  const accountId = req.session.accountId;
  try {
    db.prepare(`DELETE FROM acknowledgements WHERE summary_id=? AND topic_index=? AND account_id=?`).run(summary_id, topic_index, accountId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/acks/:summary_id', (req, res) => {
  const rows = db.prepare(`
    SELECT a.topic_index, a.account_id, a.acked_at, ac.display_name
    FROM acknowledgements a
    JOIN accounts ac ON ac.id = a.account_id
    WHERE a.summary_id = ?
  `).all(req.params.summary_id);
  res.json(rows);
});

// ---------- Prompt Settings API ----------
app.get('/api/settings/prompt', requireAdmin, (req, res) => {
  res.json({
    intro: getPromptSetting('prompt_intro', DEFAULT_PROMPT_INTRO),
    rules: getPromptSetting('prompt_rules', DEFAULT_PROMPT_RULES),
    how: getPromptSetting('prompt_how', DEFAULT_PROMPT_HOW),
  });
});

app.put('/api/settings/prompt', requireAdmin, (req, res) => {
  const { intro, rules, how } = req.body;
  if (intro !== undefined) setPromptSetting('prompt_intro', intro);
  if (rules !== undefined) setPromptSetting('prompt_rules', rules);
  if (how !== undefined) setPromptSetting('prompt_how', how);
  res.json({ ok: true });
});

app.post('/api/settings/prompt/reset', requireAdmin, (req, res) => {
  setPromptSetting('prompt_intro', DEFAULT_PROMPT_INTRO);
  setPromptSetting('prompt_rules', DEFAULT_PROMPT_RULES);
  setPromptSetting('prompt_how', DEFAULT_PROMPT_HOW);
  res.json({ ok: true });
});

// ---------- Admin: Account Management ----------
app.get('/api/admin/accounts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM accounts ORDER BY id').all();
  res.json(rows);
});

app.post('/api/admin/accounts', requireAdmin, (req, res) => {
  const { username, password, display_name, is_admin } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'username, password, display_name required' });
  try {
    const result = db.prepare(`INSERT INTO accounts (username, password_hash, display_name, is_admin, created_at) VALUES (?,?,?,?,?)`)
      .run(username, hashPassword(password), display_name, is_admin ? 1 : 0, Date.now());
    res.json({ id: result.lastInsertRowid, username, display_name, is_admin: is_admin ? 1 : 0 });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/accounts/:id', requireAdmin, (req, res) => {
  const { display_name, password, is_admin } = req.body;
  const id = parseInt(req.params.id);
  if (password) {
    db.prepare('UPDATE accounts SET display_name=?, is_admin=?, password_hash=? WHERE id=?').run(display_name, is_admin ? 1 : 0, hashPassword(password), id);
  } else {
    db.prepare('UPDATE accounts SET display_name=?, is_admin=? WHERE id=?').run(display_name, is_admin ? 1 : 0, id);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/accounts/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.accountId) return res.status(400).json({ error: 'cannot delete yourself' });
  db.prepare('DELETE FROM acknowledgements WHERE account_id=?').run(id);
  db.prepare('DELETE FROM account_group_access WHERE account_id=?').run(id);
  db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  res.json({ ok: true });
});

// ---------- Admin: Group Access Control ----------
app.get('/api/admin/access/:account_id', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT group_id FROM account_group_access WHERE account_id=?').all(req.params.account_id);
  res.json(rows.map(r => r.group_id));
});

app.put('/api/admin/access/:account_id', requireAdmin, (req, res) => {
  const accountId = parseInt(req.params.account_id);
  const { group_ids } = req.body; // array of group_ids
  db.prepare('DELETE FROM account_group_access WHERE account_id=?').run(accountId);
  const stmt = db.prepare('INSERT OR IGNORE INTO account_group_access (account_id, group_id) VALUES (?,?)');
  for (const gid of (group_ids || [])) stmt.run(accountId, gid);
  res.json({ ok: true });
});

// ---------- Admin: All groups (for access management) ----------
app.get('/api/admin/groups', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT group_id, group_name FROM groups ORDER BY group_name').all();
  res.json(rows);
});

// ---------- Admin: Delete group ----------
app.delete('/api/admin/groups/:group_id', requireAdmin, (req, res) => {
  const group_id = req.params.group_id;
  db.prepare('DELETE FROM account_group_access WHERE group_id=?').run(group_id);
  db.prepare('DELETE FROM acknowledgements WHERE summary_id IN (SELECT id FROM summaries WHERE group_id=?)').run(group_id);
  db.prepare('DELETE FROM summaries WHERE group_id=?').run(group_id);
  db.prepare('DELETE FROM images WHERE group_id=?').run(group_id);
  db.prepare('DELETE FROM messages WHERE group_id=?').run(group_id);
  db.prepare('DELETE FROM groups WHERE group_id=?').run(group_id);
  res.json({ ok: true });
});

// ---------- Cron ----------
cron.schedule('55 23 * * *', async () => {
  const today = thaiDateString(Date.now());
  const groups = db.prepare('SELECT DISTINCT group_id FROM messages WHERE date=?').all(today);
  for (const g of groups) {
    try { await summarizeDate(g.group_id, today); } catch(err) { console.error('[cron]', err); }
  }
}, { timezone: 'Asia/Bangkok' });

// ---------- Static ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`i-Tail Insight running on http://localhost:${PORT}`));