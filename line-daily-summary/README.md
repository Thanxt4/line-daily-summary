# สรุปกลุ่มไลน์รายวัน

ระบบนี้ทำ 3 อย่าง:
1. รับข้อความจากกลุ่มไลน์แบบ real-time ผ่าน LINE Messaging API (webhook)
2. เก็บข้อความลงฐานข้อมูล SQLite
3. สรุปข้อความของแต่ละวันด้วย Claude อัตโนมัติทุกคืน (23:55 น.) และดูผลผ่านหน้าเว็บ

**ข้อจำกัดสำคัญ:** บอทจะเห็นเฉพาะข้อความที่ส่ง **หลังจาก** เชิญเข้ากลุ่มแล้วเท่านั้น ไม่สามารถดึงประวัติแชทเก่าย้อนหลังได้ (LINE ไม่มี API ให้ทำแบบนั้น)

---

## ขั้นตอนที่ 1: สร้าง LINE Official Account + Messaging API

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) แล้วล็อกอินด้วยบัญชี LINE
2. สร้าง **Provider** ใหม่ (ตั้งชื่ออะไรก็ได้ เช่น ชื่อบริษัท/โปรเจกต์)
3. ในหน้า Provider กด **Create a Messaging API channel**
   - กรอกชื่อ, หมวดหมู่, คำอธิบาย ตามต้องการ
4. เข้าไปที่ channel ที่สร้าง แล้วไปแท็บ **Messaging API**
   - เลื่อนหา **Channel access token** กด Issue เพื่อออก token (ยาวตลอดไป) → คัดลอกเก็บไว้
   - กลับไปแท็บ **Basic settings** คัดลอก **Channel secret** เก็บไว้
5. ในแท็บ **Messaging API** เลื่อนหา **Allow bot to join group chats** ให้เปิดเป็น **Enabled**
6. ไปที่ [LINE Official Account Manager](https://manager.line.biz/) เลือกบัญชีเดียวกัน
   - ปิด **Auto-reply messages** และ **Greeting messages** (เพื่อไม่ให้บอทตอบกลับเอง จะได้ไม่รบกวนกลุ่ม)

ตอนนี้คุณจะมี 2 ค่าที่ต้องใช้: `LINE_CHANNEL_SECRET` และ `LINE_CHANNEL_ACCESS_TOKEN`

---

## ขั้นตอนที่ 2: ขอ Google Gemini API Key (ฟรี)

1. ไปที่ [aistudio.google.com/apikey](https://aistudio.google.com/apikey) แล้วล็อกอินด้วยบัญชี Google
2. กด **Create API key** → คัดลอกเก็บไว้เป็น `GEMINI_API_KEY`
3. ไม่ต้องผูกบัตรเครดิต ใช้ฟรีภายใต้โควตารายวัน (เพียงพอสำหรับสรุปแชทวันละครั้งสบายๆ)

> **ข้อควรทราบ:** เนื่องจากเป็น free tier ข้อความที่ส่งเข้าไปอาจถูก Google นำไปใช้พัฒนาโมเดล (ยกเว้นบัญชีในยุโรป/UK/สวิตเซอร์แลนด์) หากกลุ่มไลน์มีข้อมูลที่ละเอียดอ่อนมาก ควรพิจารณาใช้ API แบบเสียเงิน (เช่น Anthropic) แทน

---

## ขั้นตอนที่ 3: รันทดสอบในเครื่องตัวเอง (ไม่บังคับ)

```bash
npm install
cp .env.example .env
# แก้ไฟล์ .env ใส่ค่าที่คัดลอกมา
npm run dev
```

เซิร์ฟเวอร์จะรันที่ `http://localhost:3000` — แต่ LINE ต้องการ URL แบบ HTTPS ที่เข้าถึงจากอินเทอร์เน็ตได้ ดังนั้นสำหรับการใช้งานจริงต้อง deploy ตามขั้นตอนที่ 4

---

## ขั้นตอนที่ 4: Deploy ขึ้น Railway (แนะนำ)

Railway เหมาะเพราะ: deploy จาก GitHub ได้ในไม่กี่คลิก, มี HTTPS URL ให้ทันที, และรองรับ **Volume** สำหรับเก็บไฟล์ `data.db` ให้ข้อมูลไม่หายตอน redeploy

1. อัปโหลดโค้ดโปรเจกต์นี้ขึ้น GitHub repo (สร้าง repo ใหม่แล้ว push โค้ดทั้งหมดที่ให้ไป)
2. ไปที่ [railway.app](https://railway.app) → สมัคร/ล็อกอิน (ใช้ GitHub ล็อกอินได้เลย)
3. กด **New Project → Deploy from GitHub repo** เลือก repo ที่เพิ่งสร้าง
4. ไปที่แท็บ **Variables** ของ service ใส่ตัวแปรทั้งหมด:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (ใส่ `gemini-2.5-flash` หรือเว้นว่างได้ จะใช้ค่านี้เป็นค่าเริ่มต้น)
   - `ADMIN_USERNAME` และ `ADMIN_PASSWORD` — บัญชีสำหรับล็อกอินเข้าหน้าแดชบอร์ด (ค่าเริ่มต้นคือ `admin` / `admin123` **ควรเปลี่ยนก่อนใช้งานจริง**)
   - `SESSION_SECRET` — ตั้งเป็นข้อความยาวๆ สุ่มๆ อะไรก็ได้ (ใช้เข้ารหัส session ไม่ให้คนอื่นปลอมล็อกอิน)
5. ไปที่แท็บ **Settings → Volumes** กด **New Volume** mount ที่ path `/app` (เพื่อให้ `data.db` ไม่หายเวลา deploy ใหม่)
6. ไปที่แท็บ **Settings → Networking** กด **Generate Domain** จะได้ URL แบบ `https://xxxx.up.railway.app`
7. รอ deploy เสร็จ (ดู log ในแท็บ Deployments)

---

## ขั้นตอนที่ 5: ตั้งค่า Webhook ใน LINE

1. กลับไปที่ LINE Developers Console → channel ของคุณ → แท็บ **Messaging API**
2. ที่ช่อง **Webhook URL** ใส่: `https://xxxx.up.railway.app/webhook` (แทนด้วย URL จริงจาก Railway)
3. กด **Verify** ต้องขึ้นสถานะสำเร็จ (ถ้าไม่สำเร็จ ให้เช็ก log บน Railway ว่ามี error อะไร)
4. เปิดสวิตช์ **Use webhook** ให้เป็น Enabled

---

## ขั้นตอนที่ 6: เชิญบอทเข้ากลุ่มไลน์

1. ในแท็บ **Messaging API** ของ console จะมี **QR code** หรือ **Bot basic ID** ของบอท
2. เพิ่มบอทเป็นเพื่อนในแอป LINE ด้วย QR code นั้น
3. เชิญบอทเข้ากลุ่มที่ต้องการเก็บสรุป (เหมือนเชิญเพื่อนเข้ากลุ่มปกติ)

จากจุดนี้ ทุกข้อความในกลุ่มจะถูกเก็บลงฐานข้อมูลอัตโนมัติ

---

## ขั้นตอนที่ 7: ดูสรุป

เข้า `https://xxxx.up.railway.app/` จะเจอหน้า **เข้าสู่ระบบ** ก่อน — ล็อกอินด้วยค่าที่ตั้งไว้ใน `ADMIN_USERNAME` / `ADMIN_PASSWORD` (ค่าเริ่มต้นคือ `admin` / `admin123`)

หลังล็อกอินแล้วจะเห็นหน้าแดชบอร์ด:
- รายชื่อกลุ่มไลน์ที่เชื่อมต่ออยู่ทางเมนูซ้าย (กลุ่มจะโผล่มาหลังจากมีข้อความแรกเข้ามา)
- เลือกกลุ่มเพื่อดูสรุปแต่ละวัน เรียงจากล่าสุดไปเก่าสุด
- ระบบจะสรุปให้อัตโนมัติทุกคืนเวลา 23:55 น. (เวลาไทย)
- หรือกดปุ่ม **"สรุปวันนี้ทันที"** เพื่อสรุปข้อความของวันนี้แบบสดๆ ได้ทุกเมื่อ
- กด **"ออกจากระบบ"** ที่มุมล่างซ้ายเพื่อล็อกเอาต์

---

## โครงสร้างไฟล์

```
line-daily-summary/
├── server.js          # Express server: webhook, cron, API, login/session
├── package.json
├── .env.example       # ตัวอย่างตัวแปรสภาพแวดล้อม
├── public/
│   ├── login.html      # หน้าเข้าสู่ระบบ
│   └── index.html      # หน้าแดชบอร์ดดูสรุป
└── data.db             # ฐานข้อมูล SQLite (สร้างอัตโนมัติตอนรันครั้งแรก)
```

## ปรับแต่งเพิ่มเติมที่ทำได้

- เปลี่ยนเวลาสรุปอัตโนมัติ: แก้บรรทัด `cron.schedule('55 23 * * *', ...)` ใน `server.js`
- ส่งสรุปกลับเข้ากลุ่มไลน์อัตโนมัติ: เพิ่มการเรียก LINE Push Message API หลังสรุปเสร็จใน `summarizeDate()`
- เปลี่ยนภาษา/รูปแบบสรุป: แก้ prompt ในฟังก์ชัน `summarizeDate()`
