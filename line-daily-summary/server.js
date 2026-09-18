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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TZ_OFFSET_HOURS = 7; // Asia/Bangkok
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-this-secret';

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET ยังไม่ได้ตั้งค่าใน .env กำลังใช้ค่า default ซึ่งไม่ปลอดภัยสำหรับ production');
}

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  console.warn('[warn] LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่าใน .env');
}
if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY ยังไม่ได้ตั้งค่าใน .env (จำเป็นสำหรับการสรุป)');
}

// ---------- Database ----------
// Railway ตั้งค่า RAILWAY_VOLUME_MOUNT_PATH ให้อัตโนมัติเมื่อมีการแนบ Volume
// ถ้ารันในเครื่องตัวเอง (ไม่มีตัวแปรนี้) จะเก็บไฟล์ไว้ในโฟลเดอร์เดียวกับ server.js แทน
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, 'data.db'));

// โฟลเดอร์เก็บไฟล์รูปภาพที่ส่งเข้ากลุ่ม (อยู่ใน Volume เดียวกับฐานข้อมูล ไม่หายตอน deploy ใหม่)
const IMAGES_DIR = path.join(DB_DIR, 'images');
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

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
`);

// migration เล็กๆ เผื่อฐานข้อมูลเดิมสร้างไว้ก่อนที่จะมีคอลัมน์ image_refs
try {
  db.exec('ALTER TABLE summaries ADD COLUMN image_refs TEXT');
} catch (e) {
  // คอลัมน์มีอยู่แล้ว ไม่ต้องทำอะไร
}

// ---------- Helpers ----------
function thaiDateString(tsMillis) {
  const d = new Date(tsMillis + TZ_OFFSET_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getDisplayName(groupId, userId) {
  if (!userId) return 'สมาชิกในกลุ่ม';
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!resp.ok) return `สมาชิก-${userId.slice(-4)}`;
    const data = await resp.json();
    return data.displayName || `สมาชิก-${userId.slice(-4)}`;
  } catch (e) {
    return `สมาชิก-${userId.slice(-4)}`;
  }
}

async function getGroupSummary(groupId) {
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[getGroupSummary] LINE API returned ${resp.status}: ${errText}`);
      return null;
    }
    return await resp.json(); // { groupId, groupName, pictureUrl }
  } catch (e) {
    console.error('[getGroupSummary] request failed:', e.message);
    return null;
  }
}

async function ensureGroupName(groupId) {
  const existing = db.prepare(`SELECT group_id, group_name FROM groups WHERE group_id = ?`).get(groupId);
  if (!existing || existing.group_name === groupId) {
    const summary = await getGroupSummary(groupId);
    if (summary?.groupName) {
      db.prepare(
        `INSERT INTO groups (group_id, group_name) VALUES (?, ?)
         ON CONFLICT(group_id) DO UPDATE SET group_name = excluded.group_name`
      ).run(groupId, summary.groupName);
    } else if (!existing) {
      db.prepare(`INSERT OR IGNORE INTO groups (group_id, group_name) VALUES (?, ?)`).run(groupId, groupId);
    }
  }
}

async function summarizeDate(groupId, dateStr) {
  const rows = db
    .prepare(`SELECT display_name, text FROM messages WHERE group_id = ? AND date = ? ORDER BY ts ASC`)
    .all(groupId, dateStr);

  if (rows.length === 0) return null;

  const conversation = rows.map((r) => `${r.display_name || 'ไม่ทราบชื่อ'}: ${r.text}`).join('\n');

  const imageRows = db
    .prepare(`SELECT message_id FROM images WHERE group_id = ? AND date = ? ORDER BY ts ASC`)
    .all(groupId, dateStr);

  const promptText = `นี่คือบทสนทนาในกลุ่มไลน์วันที่ ${dateStr} (ข้อความที่ขึ้นต้นด้วย [ส่งรูปภาพ: xxx] คือตำแหน่งที่มีรูปภาพแนบมาด้วย ตัวรูปจริงจะแนบต่อจากข้อความนี้ พร้อมกำกับ message id ไว้):\n\n${conversation}\n\nงานของคุณมี 2 ส่วน:\n\n1. สรุปบทสนทนาเป็นภาษาไทย จัดรูปแบบตามระบบ Harvard Outline (หัวข้อหลักใช้เลขโรมัน I. II. III. หัวข้อย่อยใช้ A. B. C. และย่อยลงไปอีกใช้ 1. 2. 3.) แบ่งเป็น:\nI. ประเด็นสำคัญที่คุยกัน\nII. การตัดสินใจ/ข้อสรุป (ถ้ามี)\nIII. สิ่งที่ต้องติดตามต่อ หรือ Action Items (ถ้ามี)\nถ้าหัวข้อไหนไม่มีเนื้อหาให้ใส่ "ไม่มี" และถ้าทั้งวันไม่มีสาระสำคัญเลยให้ระบุไว้ใต้หัวข้อ I. ตรงๆ\n\n2. จากรูปภาพที่แนบมา (ถ้ามี) เลือกเฉพาะรูปที่เกี่ยวข้องกับหัวข้อสำคัญในสรุปเท่านั้น (ไม่เกิน 5 รูป ข้ามรูปที่ไม่สำคัญ เช่น มีม รูปตลก สติกเกอร์ ภาพหน้าจอที่ไม่มีสาระ) ระบุ message id ของรูปที่เลือกให้ตรงกับที่กำกับไว้ พร้อมคำบรรยายสั้นๆ ว่าเกี่ยวข้องกับหัวข้อไหน\n\nตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ในรูปแบบ:\n{"summary": "...ข้อความสรุปแบบ Harvard Outline...", "important_images": [{"message_id": "...", "caption": "..."}]}\nถ้าไม่มีรูปที่เกี่ยวข้องเลย ให้ใส่ important_images เป็น array ว่าง []`;

  const parts = [{ text: promptText }];
  for (const img of imageRows) {
    try {
      const filePath = path.join(IMAGES_DIR, `${img.message_id}.jpg`);
      if (fs.existsSync(filePath)) {
        const base64 = fs.readFileSync(filePath).toString('base64');
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64 } });
        parts.push({ text: `(รูปด้านบนนี้คือ message id: ${img.message_id})` });
      }
    } catch (e) {
      console.error('[summarizeDate] อ่านไฟล์รูปไม่สำเร็จ:', e.message);
    }
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const rawText = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  let summaryText = rawText;
  let importantImages = [];
  try {
    const parsed = JSON.parse(rawText);
    summaryText = parsed.summary || rawText;
    importantImages = Array.isArray(parsed.important_images) ? parsed.important_images : [];
  } catch (e) {
    console.error('[summarizeDate] แปลง JSON จาก Gemini ไม่สำเร็จ ใช้ข้อความดิบแทน:', e.message);
  }

  db.prepare(
    `INSERT INTO summaries (group_id, date, summary, message_count, created_at, image_refs)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, date) DO UPDATE SET
       summary = excluded.summary,
       message_count = excluded.message_count,
       created_at = excluded.created_at,
       image_refs = excluded.image_refs`
  ).run(groupId, dateStr, summaryText, rows.length, Date.now(), JSON.stringify(importantImages));

  return summaryText;
}

// ---------- LINE Webhook ----------
// Needs raw body to verify the signature, so this route is registered before express.json()
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(req.body).digest('base64');

  if (!signature || hash !== signature) {
    return res.status(401).send('invalid signature');
  }

  // Acknowledge immediately; LINE requires a fast 200 response
  res.status(200).send('OK');

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch (e) {
    return;
  }

  for (const event of body.events || []) {
    try {
      if (event.type === 'message' && event.message?.type === 'text' && event.source?.type === 'group') {
        const groupId = event.source.groupId;
        const userId = event.source.userId;
        const text = event.message.text;
        const ts = event.timestamp;
        const dateStr = thaiDateString(ts);
        const displayName = await getDisplayName(groupId, userId);

        db.prepare(
          `INSERT INTO messages (group_id, user_id, display_name, text, ts, date) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(groupId, userId, displayName, text, ts, dateStr);

        await ensureGroupName(groupId);
      } else if (event.type === 'message' && event.message?.type === 'image' && event.source?.type === 'group') {
        const groupId = event.source.groupId;
        const userId = event.source.userId;
        const ts = event.timestamp;
        const dateStr = thaiDateString(ts);
        const messageId = event.message.id;
        const displayName = await getDisplayName(groupId, userId);

        // เก็บ placeholder ไว้ในลำดับข้อความ เพื่อให้บริบทเวลาเรียงถูกต้องตอนสรุป
        db.prepare(
          `INSERT INTO messages (group_id, user_id, display_name, text, ts, date) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(groupId, userId, displayName, `[ส่งรูปภาพ: ${messageId}]`, ts, dateStr);

        try {
          const contentResp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
            headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
          });
          if (contentResp.ok) {
            const buffer = Buffer.from(await contentResp.arrayBuffer());
            fs.writeFileSync(path.join(IMAGES_DIR, `${messageId}.jpg`), buffer);
            db.prepare(`INSERT INTO images (group_id, message_id, ts, date) VALUES (?, ?, ?, ?)`).run(
              groupId,
              messageId,
              ts,
              dateStr
            );
          } else {
            console.error(`[image] ดาวน์โหลดรูปไม่สำเร็จ status ${contentResp.status}`);
          }
        } catch (err) {
          console.error('[image] ดาวน์โหลดรูปล้มเหลว:', err.message);
        }

        await ensureGroupName(groupId);
      }
    } catch (err) {
      console.error('[webhook] error handling event', err);
    }
  }
});

// ---------- JSON API (for the dashboard) ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 } // 12 ชั่วโมง
  })
);

// ---------- Login ----------
app.get('/login', (req, res) => {
  if (req.session?.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Auth guard (ป้องกันหน้าแดชบอร์ดและ API ทั้งหมด) ----------
function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login');
}

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!req.session?.loggedIn, username: req.session?.username || null });
});

app.use(requireAuth);

app.get('/media/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_-]+\.jpg$/.test(filename)) {
    return res.status(400).send('invalid filename');
  }
  const filePath = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('not found');
  }
  res.sendFile(filePath);
});

app.get('/api/groups', (req, res) => {
  const rows = db.prepare(`SELECT group_id, group_name FROM groups ORDER BY group_name`).all();
  res.json(rows);
});

app.get('/api/summaries', (req, res) => {
  const { group_id } = req.query;
  const rows = group_id
    ? db.prepare(`SELECT * FROM summaries WHERE group_id = ? ORDER BY date DESC`).all(group_id)
    : db.prepare(`SELECT * FROM summaries ORDER BY date DESC`).all();

  const withImages = rows.map((r) => {
    let images = [];
    try {
      images = r.image_refs ? JSON.parse(r.image_refs) : [];
    } catch (e) {
      images = [];
    }
    return { ...r, images: images.map((img) => ({ ...img, url: `/media/${img.message_id}.jpg` })) };
  });

  res.json(withImages);
});

app.post('/api/summarize-now', async (req, res) => {
  try {
    const { group_id, date } = req.body;
    if (!group_id) return res.status(400).json({ error: 'group_id is required' });
    const dateStr = date || thaiDateString(Date.now());
    const summary = await summarizeDate(group_id, dateStr);
    if (summary === null) {
      return res.status(404).json({ error: 'ไม่มีข้อความในวันนี้สำหรับกลุ่มนี้' });
    }
    res.json({ date: dateStr, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Daily cron job: summarize every group at 23:55 Bangkok time ----------
cron.schedule(
  '55 23 * * *',
  async () => {
    const today = thaiDateString(Date.now());
    const groups = db.prepare(`SELECT DISTINCT group_id FROM messages WHERE date = ?`).all(today);
    for (const g of groups) {
      try {
        await summarizeDate(g.group_id, today);
        console.log(`[cron] summarized ${g.group_id} for ${today}`);
      } catch (err) {
        console.error(`[cron] failed to summarize ${g.group_id}`, err);
      }
    }
  },
  { timezone: 'Asia/Bangkok' }
);

// ---------- Static dashboard ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
