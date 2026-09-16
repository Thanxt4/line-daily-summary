require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TZ_OFFSET_HOURS = 7; // Asia/Bangkok

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  console.warn('[warn] LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่าใน .env');
}
if (!GEMINI_API_KEY) {
  console.warn('[warn] GEMINI_API_KEY ยังไม่ได้ตั้งค่าใน .env (จำเป็นสำหรับการสรุป)');
}

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'data.db'));
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
    UNIQUE(group_id, date)
  );

  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    group_name TEXT
  );
`);

// ---------- Helpers ----------
function thaiDateString(tsMillis) {
  const d = new Date(tsMillis + TZ_OFFSET_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getDisplayName(groupId, userId) {
  if (!userId) return 'ไม่ทราบชื่อ';
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!resp.ok) return userId;
    const data = await resp.json();
    return data.displayName || userId;
  } catch (e) {
    return userId;
  }
}

async function getGroupSummary(groupId) {
  try {
    const resp = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!resp.ok) return null;
    return await resp.json(); // { groupId, groupName, pictureUrl }
  } catch (e) {
    return null;
  }
}

async function summarizeDate(groupId, dateStr) {
  const rows = db
    .prepare(`SELECT display_name, text FROM messages WHERE group_id = ? AND date = ? ORDER BY ts ASC`)
    .all(groupId, dateStr);

  if (rows.length === 0) return null;

  const conversation = rows.map((r) => `${r.display_name || 'ไม่ทราบชื่อ'}: ${r.text}`).join('\n');

  const prompt = `นี่คือบทสนทนาในกลุ่มไลน์วันที่ ${dateStr}:\n\n${conversation}\n\nช่วยสรุปเป็นภาษาไทยแบบกระชับ อ่านง่าย แบ่งเป็นหัวข้อ:\n1. ประเด็นสำคัญที่คุยกัน\n2. การตัดสินใจ/ข้อสรุป (ถ้ามี)\n3. สิ่งที่ต้องติดตามต่อ หรือ action items (ถ้ามี)\nถ้าเนื้อหาไม่มีสาระสำคัญ (เช่น ทักทายทั่วไป) ให้บอกตรงๆ ว่าวันนี้ไม่มีประเด็นสำคัญ`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const summaryText = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('\n')
    .trim();

  db.prepare(
    `INSERT INTO summaries (group_id, date, summary, message_count, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id, date) DO UPDATE SET
       summary = excluded.summary,
       message_count = excluded.message_count,
       created_at = excluded.created_at`
  ).run(groupId, dateStr, summaryText, rows.length, Date.now());

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

        // Remember the group (and try to fetch its name) if we haven't seen it before
        const existing = db.prepare(`SELECT group_id FROM groups WHERE group_id = ?`).get(groupId);
        if (!existing) {
          const summary = await getGroupSummary(groupId);
          db.prepare(`INSERT OR IGNORE INTO groups (group_id, group_name) VALUES (?, ?)`).run(
            groupId,
            summary?.groupName || groupId
          );
        }
      }
    } catch (err) {
      console.error('[webhook] error handling event', err);
    }
  }
});

// ---------- JSON API (for the dashboard) ----------
app.use(express.json());

app.get('/api/groups', (req, res) => {
  const rows = db.prepare(`SELECT group_id, group_name FROM groups ORDER BY group_name`).all();
  res.json(rows);
});

app.get('/api/summaries', (req, res) => {
  const { group_id } = req.query;
  const rows = group_id
    ? db.prepare(`SELECT * FROM summaries WHERE group_id = ? ORDER BY date DESC`).all(group_id)
    : db.prepare(`SELECT * FROM summaries ORDER BY date DESC`).all();
  res.json(rows);
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
