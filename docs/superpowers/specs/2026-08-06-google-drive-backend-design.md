# TavernSync — Google Drive Backend (Design Spec)

วันที่: 2026-08-06 (แก้ไขรอบ 2 หลัง spec review)
สถานะ: รอผู้ใช้ review
ขอบเขต: เพิ่ม backend "Google Drive" ให้ TavernSync โดยไม่แก้ sync algorithm หลักของ sync-core

---

## 1. เป้าหมาย / Non-goals

**เป้าหมาย**
- ให้ผู้ใช้ซิงก์ข้อมูล SillyTavern ข้ามเครื่องผ่านพื้นที่ว่างใน Google Drive ของผู้ใช้เอง โดยไม่ต้องมีเซิร์ฟเวอร์กลาง
- ความเป็นส่วนตัวระดับเดียวกับเดิมหรือดีกว่า: ข้อมูลทุกไบต์เข้ารหัสก่อนออกจากเบราว์เซอร์ (E2EE บังคับสำหรับ backend นี้) และไม่รั่วแม้แต่ชื่อ item
- backend เดิม (Cloudflare Worker) ต้องทำงานเหมือนเดิม 100% (byte-identical payload)

**Non-goals (v1)**
- ไม่ทำ automatic GC (ทำเป็นปุ่ม manual พร้อมเงื่อนไขป้องกัน)
- ไม่เปลี่ยนฟอร์แมต manifest/blob ของ Worker backend เดิม
- ไม่รองรับการใช้ Client ID คนละตัวข้ามเครื่องในบัญชีซิงก์เดียวกัน (บังคับ Client ID เดียวกันทุกเครื่อง — ดู §5)
- ไม่ทำ UI จัดการไฟล์บน Drive (ดู/ลบไฟล์ทำในเว็บ Drive เอง)

**ข้อตกลงเรื่องขอบเขตการแก้โค้ด:** ไม่แก้ algorithm ของ sync-core (scan/diff/plan/merge semantics) แต่ยอมรับการ**ขยาย engine orchestration เล็กน้อย**ที่จำเป็น — ได้แก่ adapter factory, ชนิด revision ใหม่ (§3), และท่อส่ง fork snapshot (§4)

## 2. สถาปัตยกรรม

```
SillyTavern (browser)
  └─ TavernSync extension
       ├─ Sync engine (algorithm เดิม) + orchestration ขยายเล็กน้อย
       ├─ Crypto runtime ต่อ backend (ใหม่ — ดู §6)
       └─ BackendRuntime factory (ใหม่, แทน requireAdapter() ที่ hardcode HttpStorageAdapter)
            ├─ HTTP runtime  → Cloudflare Worker (เดิม byte-identical)
            └─ Drive runtime → Google Drive API v3 จากเบราว์เซอร์โดยตรง
```

- engine ส่ง **logical content hash (plaintext hash)** เสมอ — call sites ใน engine เปลี่ยนจาก `blobStorageKey()` เดิมมาเรียก `runtime.crypto.blobNameFor(hash)`: HTTP runtime คืน raw hash (wire behavior byte-identical — regression test คุม), Drive runtime คืน HMAC
- ไม่มีเซิร์ฟเวอร์/โค้ด hosted ใด ๆ เพิ่ม — ผู้พัฒนาไม่ถือและอ่านข้อมูลผู้ใช้ไม่ได้ (zero-hosted-storage)

### โครงไฟล์บน Drive

```
TavernSync/                       ← root folder (appProperties: { ts: "root-v1" })
  ├─ manifests/
  │    └─ <commitId>.enc          ← immutable; appProperties: { ts: "commit-v1", p0: "<parentId>", p1: ... }
  └─ blobs/
       └─ <hmac-hex>              ← เนื้อ E2EE ciphertext, ชื่อ = HMAC(blob-name subkey, content hash)
```

ไม่มีไฟล์ `account.json` — salt derive จาก folderId (ดู §6)

## 3. ชนิด Revision กลาง (StorageRevision)

interface เดิมใช้ `version: number` (adapter.ts) และ `remoteVersion: number` (engine) — ไม่พอสำหรับ Drive ที่ revision คือ digest ของชุด head:

```ts
type StorageRevision = string;   // opaque — engine ห้ามตีความค่าข้างใน
```

- HTTP adapter: แปลงเลขเวอร์ชันของ worker เช่น `42` → `"42"` ที่ชายขอบของ adapter เท่านั้น (รับ `StorageRevision` เข้ามา → parse กลับเป็น number ตอนยิง `If-Match`; อ่านเลขจาก worker → แปลงเป็น string ก่อนคืน engine) — **payload และ `Manifest.version` บน wire ของ worker เหมือนเดิม byte-identical ไม่เปลี่ยนแม้แต่ไบต์เดียว**
- Drive adapter: `SHA-256(commitId ทุกหัวเรียงลำดับต่อกัน)` — heads เปลี่ยนเมื่อไหร่ revision เปลี่ยนทันที
- `BaseState.remoteVersion` เปลี่ยนเป็น `StorageRevision`
- แยกความหมายชัดเจน: `Manifest.version` (schema/logical version ในเนื้อ manifest) ≠ `StorageRevision` (สถานะฝั่ง storage) ห้ามใช้ปนกัน

## 4. RemoteSnapshot — ท่อส่ง fork ไป engine

`getManifest()` เดิมคืน manifest ก้อนเดียว ส่ง fork ไม่ได้ — เปลี่ยนเป็น:

```ts
type RemoteSnapshot =
  | { kind: 'single'; manifest: Manifest | null; revision: StorageRevision }
  | { kind: 'fork';
      heads: { commitId: string; manifest: Manifest }[];
      commonAncestor: Manifest | null;
      revision: StorageRevision };
```

- HTTP adapter คืน `kind: 'single'` เสมอ (พฤติกรรมเดิม)
- Drive adapter คืน `fork` เมื่อเจอหลาย head — engine รับ snapshot นี้แล้วทำ **merge 3 ทางด้วย semantics เดิมของ sync-core**: แก้ฝั่งเดียว=รับฝั่งนั้น / hash เดียวกัน=รับ / แก้ชนกันหรือ delete ชน edit → conflict UI เดิม (keep local / keep server / keep both) — **ห้ามตัดสินด้วย mtime ที่ชั้น storage**
- `putManifest(m, ifRevision)`: heads เปลี่ยนจากตอนอ่าน → `ConflictError` (engine re-fetch + แจ้ง retry ตามเดิม); ผ่าน → commit ใหม่ชี้ parent ทุก head ปัจจุบัน
- หมายเหตุ: writer หลายเครื่องผ่าน version check พร้อมกันแล้วเขียนสวนกัน = **เกิด fork ตามปกติ ไม่ใช่ CAS failure** — ระบบออกแบบให้ fork ถูกยุบรอบถัดไป ไม่มีข้อมูลถูกทับ

## 5. OAuth flow (GIS token model) + Bootstrap

- แผง extension เพิ่ม dropdown **Backend: Cloudflare Worker / Google Drive** (จำค่า per device)
- เลือก Drive → ช่องกรอก **Google Client ID** + ปุ่ม **Connect Google** / **Disconnect**
- กด Connect → Google Identity Services token client ขอ scope เดียว `drive.file` (เห็นเฉพาะไฟล์ที่แอปสร้าง)
- access token เก็บใน memory เท่านั้น ไม่ persist; อายุ ~1 ชม. — **renew ตอนผู้ใช้กด Push/Pull/Test ครั้งถัดไป** (token model ไม่มี refresh token และการขอใหม่ต้องมาจาก user gesture; ถ้าเคย consent แล้วส่วนมากไม่เด้ง consent ซ้ำ แต่อาจมีหน้าเลือกบัญชี)
- Disconnect = revoke token + ล้าง memory
- คู่มือในแผง: สร้าง Google Cloud project → OAuth consent screen → Web client ID → ตั้ง Authorized JavaScript origins ให้ตรง scheme/host/port ของ ST (เช่น `http://localhost:8000`; non-localhost ต้อง HTTPS; raw LAN IP ใช้ไม่ได้)

### Folder discovery

- หลัง Connect ครั้งแรก: query `appProperties has { key='ts' and value='root-v1' } and trashed=false`
  - ไม่เจอ → สร้าง root + `manifests/` + `blobs/` (เครื่องแรกของบัญชีซิงก์)
  - เจอ 1 อัน → ใช้อันนั้น
  - เจอหลายอัน → **เด้งให้ผู้ใช้เลือก** (ห้ามสร้างซ้ำเงียบ ๆ — salt ผูก folderId, คนละ root = คนละ key ทันที)
- `appProperties` มองเห็นเฉพาะ OAuth client ที่สร้าง → **บังคับ: ทุกเครื่องใช้ Client ID เดียวกัน**
- แนวทางที่แนะนำ: เครื่องแรกสร้าง root ก่อน → เครื่องอื่น Connect ทีหลัง

## 6. Crypto — BackendRuntime

ปัจจุบัน engine เข้ารหัส blob เองด้วย session key เดิมก่อนเรียก adapter (engine.ts ~575) — ดังนั้น factory ต้องคืน runtime ครบชุด ไม่ใช่แค่ storage:

```ts
interface BackendRuntime {
  storage: StorageAdapter;
  crypto: {
    encryptBlob(data: Uint8Array): Promise<Uint8Array>;
    decryptBlob(data: Uint8Array): Promise<Uint8Array>;
    encodeManifest(m: Manifest): Promise<Uint8Array>;   // Drive: encrypt ทั้งก้อน
    decodeManifest(data: Uint8Array): Promise<Manifest>;
    blobNameFor(contentHash: string): Promise<string>; // HTTP: raw hash; Drive: HMAC
  };
  saltProvider: SaltProvider;   // HTTP: getAccount/setAccount ผ่าน worker; Drive: derive จาก folderId
}
```

- **HTTP runtime:** key/format/raw hash แบบเดิม byte-identical
- **Drive runtime:** HKDF subkeys จาก root key เดิม — domain separation: `"manifest-enc"` / `"blob-enc"` / `"blob-name"`
- DriveAdapter ไม่เห็น key ดิบ — ได้แค่ codec callbacks
- salt ของ Drive: `SHA-256("TavernSync/account-salt/v1:" + folderId)` — ไม่ต้องมี account file ตัด first-write race
- ทุก subkey derive จาก passphrase ร่วม + folderId ร่วม → เหมือนกันทุกเครื่อง (หลีกเลี่ยงบั๊ก cross-device 404 ของโค้ดเดิม)
- **แยก `SaltProvider` ออกจาก `StorageAdapter`** — ไม่บังคับ `getAccount/setAccount` ใน interface storage (Drive ไม่มี account file)
- remembered key ในเครื่องต้อง namespace ด้วย backend + folderId (กันคีย์ปนกันตอนสลับ backend)
- E2EE **บังคับเปิด** สำหรับ Drive backend — ข้อมูลที่ถึง Google เป็น ciphertext ล้วน ชื่อ item ไม่รั่วเพราะ manifest เข้ารหัสทั้งก้อน

## 7. Manifest commits — metadata schema + retention

- **เขียนแบบ immutable:** push สำเร็จ = สร้าง `manifests/<commitId>.enc` ใหม่เท่านั้น ไม่เขียนทับ
- **commitId และ parentId ใช้ความยาวเดียวกัน 32 hex ตลอด** (ตัดจาก SHA-256 ของ ciphertext — ชนกันยากพอและประหยัด metadata)
- **appProperties schema** (จำกัด ~124 ไบต์/ property ของ Drive) — แยก parent ละ property จึงไม่มีทางชนลิมิต:
  - `ts: "commit-v1"` — marker
  - `p0: "<32-hex>"`, `p1: "<32-hex>"`, ... — parent ละ 1 property **สูงสุด 4 ตัว (p0–p3)**
- **N-head behavior (ห้าม storage ตัดสิน fork):**
  - `RemoteSnapshot` ส่ง heads **ทั้งหมด**เข้า engine เสมอ
  - engine auto-merge เฉพาะ item ที่ไม่ขัดกัน (แก้ฝั่งเดียว / hash เดียวกัน)
  - item ที่มีหลาย candidate (แก้ชนกัน / delete ชน edit) → ผู้ใช้เลือกผ่าน conflict UI เดิม
  - เมื่อได้ merged manifest เดียวแล้ว ถ้า parents เกิน 4 ตัว adapter สร้าง **merge commits แบบเป็นลำดับ** (commit กลางชี้ parent กลุ่มละ ≤4 จนยุบเหลือ head เดียว) — เป็นการจัดโครง commit เท่านั้น ไม่ใช่การเลือกเนื้อหา
  - **ห้ามเลือก branch จากอายุหรือ mtime ทุกกรณี**
- `device` และ `createdAt` อยู่**ใน ciphertext** ของ manifest (ไม่ใส่ metadata เปลือย); เวลาแสดงผลใช้ `createdTime` ของ Drive ได้
- **head** = commit ที่ไม่มี commit อื่นชี้เป็น parent
- **retention:** ancestry ที่ต้องรักษาคือ **ancestry ของ remote heads ระหว่างมี fork** (ทุก active head + common ancestor + commits ที่ reachable จาก heads) — ส่วน local base ของแต่ละเครื่องไม่จำเป็นต้องยังอยู่บน Drive; prune ได้**หลังเหลือ head เดียวและผ่าน grace period** — เก็บ canonical chain ล่าสุด 10 commits; เครื่องที่ base เก่ากว่าจุด prune ไม่ได้ ConflictError เสมอไป — ถ้า base ยัง reachable จาก head ปัจจุบันก็ sync ต่อได้ปกติ ถ้าไม่ reachable แล้วค่อย full re-sync

## 8. Blobs: upload / check / quota / GC

- `checkBlobs`: `files.list` เฉพาะใน `blobs/` (`parents`, `trashed=false`, fields เฉพาะที่จำเป็น, paginate 1000/หน้า) แล้วเทียบใน memory
- `putBlob`: ≤5MB ใช้ multipart; >5MB ใช้ resumable upload; ชื่อซ้ำ = เนื้อเดียวกัน → ข้าม
- `quota()`: `about.get?fields=storageQuota` คือยอด**ทั้ง Google Drive** — แสดง `Google Drive: used / limit`; ขนาดเฉพาะ TavernSync คำนวณจากไฟล์ใน root แยกต่างหาก
- **GC (v1 = ปุ่ม manual เท่านั้น):** live set = union ของ blob ที่ทุก retained commit อ้างถึง; orphan ต้องเกิน **grace period 7 วัน**; **ห้าม GC ระหว่างมี unresolved fork**; automatic GC เลื่อนออกจาก v1

## 9. Error handling

| สถานการณ์ | พฤติกรรม |
|---|---|
| token หมดอายุ | ขอใหม่ตอน user กดคำสั่งถัดไป (อาจมีหน้าเลือกบัญชี) |
| เน็ตหลุดกลาง push | ปลอดภัย — blob อัปซ้ำได้ (content-addressed), commit คือจุด atomic เดียว |
| Drive quota เต็ม (403 storageQuotaExceeded) | แจ้งชัดเจน + ชี้ไปลบของใน Drive |
| ผู้ใช้ revoke สิทธิ์แอป (401) | เด้งให้ Connect ใหม่ |
| fork | merge 3 ทางอัตโนมัติ; ชนกัน → conflict UI เดิม |
| เจอหลาย root folder | เด้งให้เลือก ไม่สร้างซ้ำ |
| manifest/blob ถูกแกะ (tamper) | AES-GCM auth tag ไม่ผ่าน → error ชัดเจน ไม่เขียนทับของดี |

## 10. Testing

- **pure tests (sync-core):** merge 3 ทาง (แก้ฝั่งเดียว / hash เดียวกัน / ชนกัน / delete ชน edit), fork retention policy
- **adapter tests (mock fetch เป็น Drive API ปลอม):** folder discovery (0/1/หลาย root), upload เล็ก/ใหญ่, checkBlobs paging, ConflictError เมื่อ heads เปลี่ยน
- **regression test:** Worker backend ส่ง payload/ชื่อ blob เหมือนเดิมเป๊ะ (raw hash, byte-identical)
- **cross-device test:** passphrase เดียวกัน + folderId เดียวกัน บน 2 "เครื่อง" → ชื่อ blob/กุญแจเหมือนกันทุกประการ
- **เพิ่มเติม:** simultaneous writers (2 เครื่อง push พร้อมกัน → fork → ยุบ), fork >2 heads, tampered ciphertext, wrong passphrase, quota limit ไม่มี (about ไม่คืน limit), สลับ backend ไปมา (remembered key ไม่ปนกัน)
- **manual E2E checklist:** PC push → มือถือ pull → แก้ไขสวนกัน → conflict UI → GC manual

## 11. ความเสี่ยงที่รับทราบ

- Google ปิดบัญชีตาม ToS ได้เสมอ — E2EE ลดความเสี่ยงเนื้อหาโดนสแกนใกล้ศูนย์ แต่ต้องมี local backup เสมอ (เขียนเตือนในคู่มือ)
- OAuth app โหมด Testing ของ Google จำกัดผู้ใช้ทดสอบ 100 คน — เพียงพอสำหรับ fork ส่วนตัว ถ้าจะแจกจ่ายกว้างต้องผ่าน verification
- ผู้ใช้ลบโฟลเดอร์ TavernSync ใน Drive เอง = ข้อมูลซิงก์หาย — คู่มือต้องเตือน
