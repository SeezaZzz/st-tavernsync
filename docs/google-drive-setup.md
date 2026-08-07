# ตั้งค่า Google Drive Backend สำหรับ TavernSync

ซิงก์ข้อมูล SillyTavern ระหว่างเครื่องผ่าน **Google Drive ของคุณเอง** — ไม่ต้อง deploy เซิร์ฟเวอร์ ไม่ต้องจ่ายเงิน ข้อมูลถูกเข้ารหัส E2EE ก่อนอัปโหลดทุกไฟล์ (Google อ่านเนื้อหาไม่ได้)

ต้องทำครั้งเดียวต่อบัญชี Google: สร้าง **OAuth Client ID ของตัวเอง** แล้วเอาไปใส่ในแผง TavernSync **ทุกเครื่องใช้ Client ID เดียวกัน**

---

## ขั้นที่ 1: สร้าง Google Cloud project + เปิด Drive API

1. เปิด [Google Cloud Console](https://console.cloud.google.com/) ล็อกอินด้วยบัญชี Google ที่จะใช้เก็บข้อมูลซิงก์
2. สร้าง project ใหม่ (ชื่ออะไรก็ได้ เช่น `tavernsync`) — ถ้ามี project อยู่แล้วใช้อันเดิมได้
3. พิมพ์ **"Google Drive API"** ในแถบค้นหาบนสุดของ Console → เปิดขึ้นมา → กด **Enable**

## ขั้นที่ 2: ตั้งค่า Google Auth Platform (ชื่อแอป + ผู้ใช้ทดสอบ)

> หน้า Console ปัจจุบันรวมการตั้งค่า OAuth ไว้ที่เมนู **Google Auth Platform** (ถ้าเมนูซ้ายไม่เห็น ให้พิมพ์ "Google Auth Platform" ในแถบค้นหาบนสุด)

1. ไปที่ **Google Auth Platform → Branding** → ใส่ชื่อแอป (เช่น `TavernSync`) + อีเมลติดต่อ → Save
2. ไปที่ **Google Auth Platform → Audience** → เลือก **External**
   - ปล่อยอยู่ใน **โหมด Testing** ได้เลย (ไม่ต้องยื่น verify กับ Google)
   - **ข้อจำกัด:** โหมด Testing จำกัด **ผู้ใช้ทดสอบไม่เกิน 100 คน** และ token จะหมดอายุบ่อยกว่าโหมด Production
   - **สำคัญ:** ในหน้า Audience เดียวกัน หัวข้อ **Test users → Add users** → เพิ่มอีเมล Google ของตัวเอง ไม่อย่างนั้นหน้าต่าง sign-in จะฟ้องว่าไม่มีสิทธิ์เข้าถึง
3. ไปที่ **Google Auth Platform → Data Access → Add or remove scopes** → ค้นหา/ติ๊ก `https://www.googleapis.com/auth/drive.file` → Save (scope เดียวพอ — เห็น/แตะได้เฉพาะไฟล์และโฟลเดอร์ที่ TavernSync สร้างเอง อ่านไฟล์อื่นใน Drive ของคุณไม่ได้)

## ขั้นที่ 3: สร้าง OAuth Client ID (Web application)

TavernSync ขอ access token ฝั่งเบราว์เซอร์ตรง ๆ (implicit/token flow) — ใช้ Client ID แบบ **Web application** ที่ต้อง whitelist ทั้ง **Authorized JavaScript origins** และ **Authorized redirect URIs** (ใส่ค่าเดียวกัน — origin ของ SillyTavern)

1. ไปที่ **Google Auth Platform → Clients → Create OAuth client** (หรือปุ่ม **Create OAuth client** ในหน้า Overview)
2. Application type: **Web application**
3. ช่อง **Authorized JavaScript origins** ใส่ origin ของ SillyTavern ให้ตรง **scheme + host + port** เป๊ะ ๆ และช่อง **Authorized redirect URIs** ใส่ origin เดียวกันต่อท้ายด้วย `/scripts/extensions/third-party/st-tavernsync/oauth-callback.html` เช่น:
   - เปิดบนเครื่องตัวเอง: origins ใส่ `http://localhost:8000` และ redirect URIs ใส่ `http://localhost:8000/scripts/extensions/third-party/st-tavernsync/oauth-callback.html` (ถ้าเปิด ST ที่ `http://127.0.0.1:8000` ให้ใส่แบบ `127.0.0.1` แทน — ดูจาก address bar ว่าเป็นอันไหน หรือใส่ไว้ทั้งคู่)
   - เข้าจากเครื่องอื่นด้วยโดเมน: `https://st.example.com` (+ callback path เดียวกันใน redirect URIs) — **origin ที่ไม่ใช่ localhost ต้องเป็น HTTPS เท่านั้น**
   - **IP LAN ดิบ ๆ (เช่น `http://192.168.1.10:8000`) ใช้ไม่ได้** — Google ไม่ยอมรับ ต้องตั้ง hostname หรือใช้ tunnel ที่เป็น HTTPS แทน
   - ใส่ได้หลาย origin — เครื่องไหนเข้า ST ผ่าน origin ไหนก็ใส่ครบทุกอัน
4. กด **Create** → ก็อปปี้ **Client ID** (หน้าตาประมาณ `xxxx.apps.googleusercontent.com`) เก็บไว้
   - ไม่ต้องใช้ Client Secret — ห้ามเอา secret ไปวางในแผงหรือ commit ขึ้น repo

**Scope ที่ TavernSync ขอ:** `https://www.googleapis.com/auth/drive.file` เพียงอันเดียว — เห็น/แตะได้เฉพาะไฟล์และโฟลเดอร์ที่ TavernSync สร้างเอง อ่านไฟล์อื่นใน Drive ของคุณไม่ได้

## ขั้นที่ 4: เชื่อมต่อในแผง TavernSync

### เครื่องแรก

1. เปิดแผง TavernSync → เลือก backend **Google Drive**
2. วาง **Client ID** จากขั้นที่ 3
3. กด **Connect Google** → เบราว์เซอร์จะเด้งหน้าต่าง sign-in ของ Google → เลือกบัญชี → ยอมรับ scope
4. TavernSync จะสร้างโฟลเดอร์ **TavernSync** ใน Drive ให้อัตโนมัติ (ถ้ามีหลายโฟลเดอร์ จะถามให้เลือกอันเดียว — เลือกแล้วทุกเครื่องต้องเลือกอันเดียวกัน)
5. ตั้ง **passphrase** สำหรับ E2EE → กด **Unlock** (เหมือน backend เดิม) แล้ว **↑ Push** รอบแรกได้เลย

### เครื่องถัดไป

1. ใส่ **Client ID เดียวกัน** (origin ของเครื่องนี้ต้องถูก whitelist ไว้ในขั้นที่ 3 แล้วด้วย)
2. กด **Connect Google** → ล็อกอินด้วย **บัญชี Google เดียวกัน**
3. ใส่ **passphrase เดียวกัน** → Unlock → **↓ Pull** จะได้ข้อมูลครบ

## คำเตือนสำคัญ

- **อย่าลบโฟลเดอร์ TavernSync ใน Google Drive** (รวมถึงโฟลเดอร์ย่อย `manifests/` และ `blobs/`) — ลบคือข้อมูลซิงก์หาย ถ้าเผลอลบให้รีจากถังขยะ Drive ก่อนว่าง
- **เก็บ local backup เสมอ** — Google Drive เป็นเพียงตัวกลางซิงก์ ไม่ใช่ที่เก็บสำรอง
- **ทำ passphrase หาย = ข้อมูลบน Drive อ่านไม่ได้** ไฟล์ทั้งหมดเป็น `.enc` ชื่อ hex เข้ารหัสด้วยคีย์จาก passphrase ของคุณ ไม่มีทางกู้ — จดเก็บไว้ที่ปลอดภัย
- กด **Disconnect** จะถอน token ฝั่ง Google ด้วย — ถ้าอยากเพิกถอนสิทธิ์ถาวร ไปที่ [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
- **อย่า commit หรือส่ง Client ID/secret ขึ้นที่สาธารณะ** ถ้าไม่จำเป็น (Client ID ไม่ใช่ความลับ แต่เลี่ยงไว้ดีกว่า)

---

## Manual E2E Checklist (ทำบนเครื่องจริง — ต้องมีบัญชี Google + Client ID จริง)

สภาพแวดล้อม CI/headless ทำขั้นเหล่านี้ไม่ได้ (ต้องมีเบราว์เซอร์จริง + Google sign-in) — ทำทีละข้อ แล้วทิ้งผลไว้ใน PR/commit message

- [ ] **Connect flow:** กรอก Client ID → Connect Google → popup sign-in ขึ้น → ยอมรับ scope `drive.file` → สถานะขึ้น connected โดยไม่มี error ใน console
- [ ] **First-run folder:** เครื่องแรกสร้างโฟลเดอร์ `TavernSync` ใน Drive อัตโนมัติ — เช็กในเว็บ Drive เห็นโฟลเดอร์จริง
- [ ] **Multi-root picker:** (จำลองโดยสร้างโฟลเดอร์ TavernSync ซ้ำเองใน Drive อีกอัน) Connect ใหม่ → popup เลือก root เด้ง → **ยืนยันว่าเลือก radio แล้วกด OK ได้ค่าที่เลือกจริง** (ไม่ได้ค่า null/ค่าแรกเสมอ) — *ความเสี่ยงที่ยังไม่ได้ยืนยัน: DOM ของ popup อาจถูก detach หลัง confirm ทำให้ `document.querySelector('input[name="ts_drive_root"]:checked')` ใน `src/index.ts pickDriveRoot` อ่านค่าไม่ได้* — ถ้าพังให้รายงานเป็น bug
- [ ] **Unlock:** ใส่ passphrase → Unlock สำเร็จ → รีเฟรชหน้าแล้วยังจำคีย์ (ไม่ต้อง Unlock ใหม่) ถ้าไม่ได้เปิดโหมดถามทุกครั้ง
- [ ] **First push:** Push ข้อมูลจริงขึ้น Drive → ในเว็บ Drive เห็น `TavernSync/manifests/` + `blobs/` เป็นไฟล์ `.enc` ชื่อ hex **เท่านั้น** (ไม่มีชื่อไฟล์/เนื้อหาอ่านได้)
- [ ] **Pull เครื่อง 2:** browser profile/เครื่องอื่น — Client ID + บัญชี Google + passphrase เดียวกัน → Connect → Unlock → Pull ได้ข้อมูลครบ (ตัวละคร/แชท/การตั้งค่าตาม scope)
- [ ] **Fork conflict:** แก้ไขคนละเครื่องสวนกัน → Push ทั้งคู่ → ฝั่งหลังเจอ conflict → fork ถูก merge หรือ conflict UI เด้งตามคาด เลือกแก้ผ่าน UI ได้จนซิงก์ต่อได้
- [ ] **ออฟไลน์กลาง push:** ปิดเน็ตระหว่าง Push → error ชัดเจน → เปิดเน็ต Push ใหม่ได้ปกติ ไม่มีไฟล์เสีย/manifest พัง
- [ ] **Passphrase ผิด:** ใส่ผิดตอน Unlock → decrypt fail error ชัดเจน **และไม่มีการเขียนทับข้อมูลบน Drive**
- [ ] **GC:** กดปุ่ม GC → ไฟล์ที่กำลังถูกอ้างถึงไม่หาย, blob/manifest orphan เก่าถูกย้ายเข้าถังขยะ Drive
- [ ] **Disconnect:** กด Disconnect → token ถูก revoke → Push/Pull ต่อไม่ได้จนกว่าจะ Connect ใหม่
- [ ] **สลับ backend:** เปลี่ยนกลับ backend Worker เดิม → Push/Pull ใช้ได้เหมือนเดิม (คีย์ E2EE ที่จำไว้ของทั้งสอง backend ไม่ปนกัน)
