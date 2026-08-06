# Google Drive Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่ม backend "Google Drive" ให้ TavernSync (zero-hosted-storage, E2EE บังคับ) โดยไม่เปลี่ยนพฤติกรรม Worker backend เดิม

**Architecture:** เพิ่ม `BackendRuntime` factory (storage + crypto + saltProvider ครบชุดต่อ backend), ขยาย interface ด้วย `StorageRevision` (string) และ `RemoteSnapshot` (รองรับ fork), Drive adapter เก็บ manifest เป็น immutable commits + blobs ชื่อ HMAC — sync algorithm ของ sync-core ไม่เปลี่ยน

**Tech Stack:** TypeScript, webpack, vitest, Google Drive API v3 (fetch ตรง), Google Identity Services (token model), WebCrypto (PBKDF2/HKDF/AES-GCM/HMAC — มีอยู่ใน `src/crypto/index.ts`)

**Spec อ้างอิง:** `docs/superpowers/specs/2026-08-06-google-drive-backend-design.md` (commit 98d83f8)

## Global Constraints

- ห้ามเปลี่ยน wire behavior ของ Worker backend — payload/headers/blob names ต้อง byte-identical (มี regression test คุม)
- ห้ามแก้ algorithm ใน `src/sync-core/` (diff/plan/apply/conflict semantics) — เพิ่มไฟล์ใหม่ได้ แก้ semantics เดิมไม่ได้
- engine ส่ง logical content hash (plaintext hash) เสมอ; การแปลงชื่อ blob อยู่ใน `runtime.crypto.blobNameFor()` เท่านั้น
- E2EE บังคับสำหรับ Drive backend; ข้อมูลทุกไบต์ที่ออกจากเบราว์เซอร์ต้องเข้ารหัส; ชื่อ item ห้ามรั่ว (manifest เข้ารหัสทั้งก้อน)
- ห้ามตัดสิน fork ด้วย mtime/อายุที่ชั้น storage — conflict ทุกกรณีผ่าน UI เดิม
- commitId/parentId = 32 hex จาก SHA-256 ของ ciphertext; parents สูงสุด 4 (appProperties `p0`–`p3`)
- GC เป็น manual เท่านั้นใน v1, orphan grace 7 วัน, ห้าม GC ระหว่างมี fork
- เทสทั้งหมดอยู่ใน `src/**/__tests__/**/*.test.ts` รันด้วย `npm test` (vitest, environment node)
- Build: `npm run build` (webpack) — version bump ต้องแก้ 3 จุดพร้อมกัน: `package.json`, `src/settings.ts` (BUILD_ID), `manifest.json` (js/css/version)

---

### Task 1: StorageRevision + ขยาย StorageAdapter interface

**Files:**
- Modify: `src/backend/adapter.ts`
- Modify: `src/backend/http.ts:34-66` (getManifest/putManifest แปลง number↔string ที่ชายขอบ)
- Test: `src/backend/__tests__/http-revision.test.ts` (สร้างใหม่)

**Interfaces:**
- Produces:
  - `export type StorageRevision = string;` (adapter.ts)
  - `getSnapshot(): Promise<RemoteSnapshot>` — แทน `getManifest()` บน interface (remoteSnapshot นิยามใน Task นี้ด้วย)
  - `putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }>`
  - `RemoteSnapshot = { kind: 'single'; manifest: Manifest | null; revision: StorageRevision } | { kind: 'fork'; heads: { commitId: string; manifest: Manifest }[]; commonAncestor: Manifest | null; revision: StorageRevision }`

- [ ] **Step 1: เขียน failing test — HTTP adapter แปลง revision ที่ชายขอบและ wire ไม่เปลี่ยน**

สร้าง `src/backend/__tests__/http-revision.test.ts` (mock fetch แบบเดียวกับที่จะใช้ทั้ง plan — global `fetch` ถูกแทนด้วย stub):

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpStorageAdapter } from '../http';

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('HttpStorageAdapter revision boundary', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('getSnapshot คืน kind single และ revision เป็น string จาก header X-Manifest-Version', async () => {
        const manifest = { version: 7, schema: 1, device: 'pc', updatedAt: 1, items: {} };
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ manifest }, { 'X-Manifest-Version': '7' })));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        const snap = await a.getSnapshot();
        expect(snap.kind).toBe('single');
        if (snap.kind === 'single') {
            expect(snap.revision).toBe('7');
            expect(snap.manifest).toEqual(manifest);
        }
    });

    it('putManifest ส่ง If-Match เป็นตัวเลขเดิมบน wire (parse จาก StorageRevision)', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return jsonResponse({ version: 8 }); }));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        const m = { version: 8, schema: 1 as const, device: 'pc', updatedAt: 2, items: {} };
        const r = await a.putManifest(m, '7');
        expect(r.revision).toBe('8');
        expect((calls[0].init.headers as Record<string, string>)['If-Match']).toBe('7');
        expect(String(calls[0].url)).toBe('https://x.workers.dev/v1/manifest');
    });

    it('putManifest เจอ 412 → ConflictError', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'conflict', version: 9 }, {}, 412)));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        await expect(a.putManifest({ version: 9, schema: 1, device: 'pc', updatedAt: 3, items: {} }, '7'))
            .rejects.toMatchObject({ name: 'ConflictError' });
    });
});
```

- [ ] **Step 2: รันเทสให้เห็น fail**

Run: `npm test -- src/backend/__tests__/http-revision.test.ts`
Expected: FAIL — `a.getSnapshot is not a function` (ยังไม่มี method ใหม่)

- [ ] **Step 3: แก้ adapter.ts — เพิ่ม StorageRevision, RemoteSnapshot, เปลี่ยน interface**

```ts
// src/backend/adapter.ts
import type { Manifest } from '../sync-core/types';

export class ConflictError extends Error {
    constructor(message = 'Manifest version conflict') {
        super(message);
        this.name = 'ConflictError';
    }
}

/** Opaque storage-side revision. engine ห้ามตีความค่าข้างใน */
export type StorageRevision = string;

export type RemoteSnapshot =
    | { kind: 'single'; manifest: Manifest | null; revision: StorageRevision }
    | {
          kind: 'fork';
          heads: { commitId: string; manifest: Manifest }[];
          commonAncestor: Manifest | null;
          revision: StorageRevision;
      };

export interface StorageAdapter {
    getSnapshot(): Promise<RemoteSnapshot>;
    putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }>;
    checkBlobs(hashes: string[]): Promise<string[]>;
    getBlob(hash: string): Promise<Uint8Array>;
    putBlob(hash: string, data: Uint8Array): Promise<void>;
}
```

หมายเหตุ: `quota()` และ account methods (`getAccount/ensureAccountSalt`) ไม่อยู่บน interface (HTTP มีเป็นพิเศษของ class; salt ย้ายไป SaltProvider ใน Task 2)

- [ ] **Step 4: แก้ http.ts — rename getManifest→getSnapshot, แปลง revision ที่ชายขอบ**

ใน `src/backend/http.ts`:
- เปลี่ยน method `getManifest()` เป็น `async getSnapshot(): Promise<RemoteSnapshot>` — logic เดิมทุกอย่าง แต่ห่อคืน `{ kind: 'single', manifest, revision: String(version) }` (404 → `{ kind: 'single', manifest: null, revision: '0' }`)
- `putManifest(m: Manifest, ifRevision: StorageRevision)`: header `If-Match: String(Number(ifRevision))` (parse กลับเป็น number เพื่อรักษา wire เดิม — worker เดิมรับตัวเลขธรรมดา); สำเร็จคืน `{ revision: String(version) }`; 412 → `throw new ConflictError()` เหมือนเดิม
- ที่เหลือของ http.ts (checkBlobs/getBlob/putBlob/quota/getAccount/ensureAccountSalt/uploadBlobsParallel) ไม่แตะ

- [ ] **Step 5: รันเทสให้ผ่าน**

Run: `npm test -- src/backend/__tests__/http-revision.test.ts`
Expected: PASS 3 เคส

- [ ] **Step 6: แก้ compile errors ฝั่ง engine ให้ผ่านแบบชั่วคราว**

engine.ts ยังเรียก `getManifest()` เดิม — เปลี่ยนจุดเรียกทั้ง 4 (engine.ts:56, 341, 469, 713) มาใช้ `getSnapshot()` แล้ว destructure: `const snap = await adapter.getSnapshot(); const remote = snap.kind === 'single' ? snap.manifest : null; const remoteVersion = snap.revision;` (กรณี fork ชั่วคราว throw `new Error('fork unsupported on this backend')` — Task 7 จะมาใส่จริง) และ `remoteVersion` type เปลี่ยนเป็น `StorageRevision` ทั้ง `BaseState` (engine.ts:24), local var (engine.ts:338), getStatusDiff return (engine.ts:326)

Run: `npx tsc --noEmit` — Expected: ผ่าน (หรือเหลือเฉพาะ error ที่เกี่ยว emptyManifest ซึ่งแก้ใน step ถัดไป)

- [ ] **Step 7: แยก Manifest.version ออกจาก storage revision**

engine.ts:702 เดิม `emptyManifest(s.deviceName || 'device', remoteVersion)` — remoteVersion ตอนนี้เป็น string แล้ว เปลี่ยนเป็นใช้เลข logical จาก manifest เดิม:

```ts
const nextLogicalVersion = (remote?.version ?? 0) + 1;
const newManifest: Manifest = {
    ...emptyManifest(s.deviceName || 'device', nextLogicalVersion),
    items: newItems,
    updatedAt: Date.now(),
};
```

(บน worker: ปกติ manifest.version เดิมตาม storage version อยู่แล้ว การ +1 จาก remote.version ให้ลำดับเดิมในการใช้งานจริง — regression test Task 1 step 1 คุมที่ชั้น wire ไม่ใช่ชั้นนี้)

- [ ] **Step 8: แก้จุดอ้าง version ใน index.ts**

index.ts:158 `toastr.success(\`Connected (v${version})\`)` — handleConnect เรียก getManifest เดิม เปลี่ยนเป็น getSnapshot และแสดง revision ตรง ๆ: `` `Connected (rev ${snap.revision.slice(0, 12)})` ``

Run: `npx tsc --noEmit` Expected: ผ่านทั้งโปรเจกต์

- [ ] **Step 9: Commit**

```bash
git add src/backend/adapter.ts src/backend/http.ts src/backend/__tests__/http-revision.test.ts src/sync/engine.ts src/index.ts
git commit -m "feat: introduce StorageRevision + RemoteSnapshot on StorageAdapter (HTTP wire unchanged)"
```

---

### Task 2: BackendRuntime factory + SaltProvider + ย้าย blob crypto เข้า runtime

**Files:**
- Create: `src/backend/runtime.ts`
- Modify: `src/sync/engine.ts` (requireAdapter → requireRuntime, maybeEncrypt/maybeDecrypt/blobStorageKey → runtime.crypto, syncAccountSalt → saltProvider, remembered key namespace)
- Test: `src/backend/__tests__/runtime-http.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: `StorageRevision`, `RemoteSnapshot`, `StorageAdapter` (Task 1), `seal/open/deriveKey/importAesKey/exportKeyRaw` (`src/crypto/index.ts`), `getSettings` (`src/settings.ts`)
- Produces:

```ts
// src/backend/runtime.ts
export interface SaltProvider {
    /** canonical salt ของบัญชีซิงก์นี้ (null = ยังไม่มี) */
    getSalt(): Promise<Uint8Array | null>;
    /** ลงทะเบียน salt แรก; คืน canonical salt (อาจต่างจาก local ถ้ามีอยู่แล้ว) */
    ensureSalt(local: Uint8Array): Promise<Uint8Array>;
}

export interface BackendCrypto {
    encryptBlob(data: Uint8Array): Promise<Uint8Array>;
    decryptBlob(data: Uint8Array, expectedPlaintextHash: string): Promise<Uint8Array>;
    encodeManifest(m: Manifest): Promise<Uint8Array>;
    decodeManifest(data: Uint8Array): Promise<Manifest>;
    blobNameFor(contentHash: string): Promise<string>;
}

export interface BackendRuntime {
    storage: StorageAdapter;
    crypto: BackendCrypto;
    saltProvider: SaltProvider;
    /** key สำหรับ namespace remembered key ใน localforage เช่น "http:<host>" หรือ "drive:<folderId>" */
    storageNamespace: string;
}

export async function requireRuntime(): Promise<BackendRuntime>;
```

- [ ] **Step 1: เขียน failing test — HTTP runtime ต้อง byte-identical กับพฤติกรรมเดิม**

สร้าง `src/backend/__tests__/runtime-http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeHttpCrypto } from '../runtime';
import { deriveKey, seal, open } from '../../crypto';

describe('makeHttpCrypto', () => {
    it('blobNameFor คืน raw hash (ไม่แปลง)', async () => {
        const c = makeHttpCrypto(null);
        expect(await c.blobNameFor('ab12cd')).toBe('ab12cd');
    });

    it('encryptBlob/decryptBlob ใช้ legacy sessionKey seal/open รอบทริปได้', async () => {
        const { key } = await deriveKey('pass', new Uint8Array(16).fill(1));
        const c = makeHttpCrypto(key);
        const data = new TextEncoder().encode('hello tavern');
        const boxed = await c.encryptBlob(data);
        // legacy layout: IV(12) || ciphertext
        const back = await open(key, boxed);
        expect(new TextDecoder().decode(back)).toBe('hello tavern');
        await expect(c.decryptBlob(boxed, '')).resolves.toEqual(data);
    });

    it('encodeManifest เป็น JSON ธรรมดา (worker เก็บ plaintext manifest)', async () => {
        const c = makeHttpCrypto(null);
        const m = { version: 1, schema: 1 as const, device: 'pc', updatedAt: 1, items: {} };
        const enc = await c.encodeManifest(m);
        expect(JSON.parse(new TextDecoder().decode(enc))).toEqual(m);
    });
});
```

หมายเหตุ test env: vitest environment เป็น node — WebCrypto ใช้ผ่าน `globalThis.crypto` ของ Node 20+ ได้ตรง ๆ (โค้ด `src/crypto/index.ts` อ้าง `crypto.subtle` อยู่แล้ว)

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/__tests__/runtime-http.test.ts`
Expected: FAIL — `makeHttpCrypto is not exported`

- [ ] **Step 3: สร้าง runtime.ts — HTTP runtime (legacy ทุกอย่าง)**

```ts
// src/backend/runtime.ts
import type { Manifest } from '../sync-core/types';
import type { StorageAdapter } from './adapter';
import { HttpStorageAdapter } from './http';
import { getSettings } from '../settings';
import { seal, open, decodeSalt, encodeSalt } from '../crypto';

export interface SaltProvider {
    getSalt(): Promise<Uint8Array | null>;
    ensureSalt(local: Uint8Array): Promise<Uint8Array>;
}

export interface BackendCrypto {
    encryptBlob(data: Uint8Array): Promise<Uint8Array>;
    decryptBlob(data: Uint8Array, expectedPlaintextHash: string): Promise<Uint8Array>;
    encodeManifest(m: Manifest): Promise<Uint8Array>;
    decodeManifest(data: Uint8Array): Promise<Manifest>;
    blobNameFor(contentHash: string): Promise<string>;
}

export interface BackendRuntime {
    storage: StorageAdapter;
    crypto: BackendCrypto;
    saltProvider: SaltProvider;
    storageNamespace: string;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Legacy HTTP crypto: encrypt ด้วย sessionKey เดิม, manifest เป็น JSON เปลือย, ชื่อ blob = raw hash */
export function makeHttpCrypto(sessionKey: CryptoKey | null): BackendCrypto {
    return {
        async encryptBlob(data) {
            if (!sessionKey) return data; // E2EE ปิด
            return seal(sessionKey, data);
        },
        async decryptBlob(data, expectedPlaintextHash) {
            if (sessionKey) {
                try {
                    const pt = await open(sessionKey, data);
                    if ((await sha256Hex(pt)) === expectedPlaintextHash) return pt;
                } catch { /* fallthrough: blob เก่ายุค E2EE ปิด */ }
            }
            if ((await sha256Hex(data)) === expectedPlaintextHash) return data;
            throw new Error('blob hash mismatch / decrypt failed');
        },
        async encodeManifest(m) { return new TextEncoder().encode(JSON.stringify(m)); },
        async decodeManifest(data) { return JSON.parse(new TextDecoder().decode(data)) as Manifest; },
        async blobNameFor(hash) { return hash; },
    };
}

class HttpSaltProvider implements SaltProvider {
    constructor(private adapter: HttpStorageAdapter) {}
    async getSalt() {
        const acc = await this.adapter.getAccount();
        return acc.e2eeSalt ? decodeSalt(acc.e2eeSalt) : null;
    }
    async ensureSalt(local: Uint8Array) {
        const canonical = await this.adapter.ensureAccountSalt(encodeSalt(local));
        return decodeSalt(canonical);
    }
}

export async function requireRuntime(): Promise<BackendRuntime> {
    const s = getSettings();
    if (!s.endpoint.trim()) throw new Error('No endpoint configured');
    if (!s.deviceToken.trim()) throw new Error('No device token configured');
    const storage = new HttpStorageAdapter({ endpoint: s.endpoint.trim(), deviceToken: s.deviceToken.trim() });
    return {
        storage,
        crypto: makeHttpCrypto(getSessionKey()),
        saltProvider: new HttpSaltProvider(storage),
        storageNamespace: `http:${new URL(s.endpoint.trim()).host}`,
    };
}

// sessionKey ถูก engine จัดการ — import getter ที่ engine เปิดไว้ (ดู Step 4)
import { getSessionKey } from '../sync/engine';
```

- [ ] **Step 4: engine.ts — export getSessionKey + เปลี่ยนจุดเรียกทั้งหมดมาใช้ runtime**

ใน `src/sync/engine.ts`:
1. เพิ่ม `export function getSessionKey(): CryptoKey | null { return sessionKey; }`
2. ลบ `requireAdapter()` (บรรทัด 251-256) แทนด้วย `import { requireRuntime } from '../backend/runtime';` — ทุกจุดที่เคย `const adapter = requireAdapter()` เปลี่ยนเป็น `const rt = await requireRuntime(); const adapter = rt.storage;` (จุด: wipeRemoteSyncData :55, syncAccountSalt :126, unlockE2ee :165, getStatusDiff :340, runSync :458)
3. `blobStorageKey()` (บรรทัด 263-265) ลบทิ้ง — จุดเรียก 3 แห่งเปลี่ยนเป็น `rt.crypto.blobNameFor(hash)`:
   - `getRemoteBlob()` (:268) — เปลี่ยน signature รับ `rt: BackendRuntime` แล้วใช้ `rt.crypto.blobNameFor` + `rt.crypto.decryptBlob`
   - pushBlob callback (:581) — `const key = await rt.crypto.blobNameFor(hash);` และ `data = await rt.crypto.encryptBlob(data)` แทน `maybeEncrypt`
   - manifest rebuild (:681-687) — ใช้ `rt.crypto.blobNameFor(item.hash)`; ลบกิ่งที่เช็ค `item.hash` ดิบซ้ำ (ค้างจากยุค HMAC) เหลือเช็คชื่อเดียว
4. ลบ `maybeEncrypt/maybeDecrypt` (หน้าที่ย้ายเข้า `rt.crypto`) — จุกเรียก decrypt ใน pull path เปลี่ยนเป็น `rt.crypto.decryptBlob(bytes, expectedHash)`
5. `syncAccountSalt()` (:121-155) — เปลี่ยน `adapter.getAccount/ensureAccountSalt` เป็น `rt.saltProvider.getSalt()/ensureSalt()` (logic adopt canonical เหมือนเดิม)
6. **Remembered key namespace**: `persistRememberedKey/tryRestoreE2eeKey/forgetRememberedE2eeKey` ใช้ key ใหม่ — ใน `src/state/store.ts` เปลี่ยน `E2EE_KEY_STORAGE` จากค่าคงที่เป็นฟังก์ชัน `e2eeKeyStorageKey(namespace: string) = \`tavernsync_e2ee_key_b64:${namespace}\`` และ engine ใช้ namespace จาก runtime ล่าสุด (เก็บตัวแปร `let currentNamespace = ''` ตั้งใน requireRuntime call sites)

- [ ] **Step 5: รันเทส + typecheck**

Run: `npm test` และ `npx tsc --noEmit`
Expected: เทสทั้งหมดผ่าน (เก่า + ใหม่), ไม่มี type error

- [ ] **Step 6: Commit**

```bash
git add src/backend/runtime.ts src/backend/__tests__/runtime-http.test.ts src/sync/engine.ts src/state/store.ts
git commit -m "feat: BackendRuntime factory + SaltProvider; HTTP runtime preserves legacy behavior"
```

---

### Task 3: Drive crypto — HKDF subkeys + salt จาก folderId

**Files:**
- Create: `src/crypto/subkeys.ts`
- Test: `src/crypto/__tests__/subkeys.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: `deriveKey` (`src/crypto/index.ts:34`), `encodeSalt` (crypto/index.ts:89)
- Produces:

```ts
// src/crypto/subkeys.ts
export interface DriveSubkeys {
    manifestEnc: CryptoKey;   // AES-GCM
    blobEnc: CryptoKey;       // AES-GCM
    blobName: CryptoKey;      // HMAC SHA-256
}
export function driveSaltFromFolderId(folderId: string): Uint8Array;
export function deriveDriveSubkeys(rootKeyRaw: Uint8Array, folderId: string): Promise<DriveSubkeys>;
export function hmacNameFor(blobNameKey: CryptoKey, contentHash: string): Promise<string>;
```

- [ ] **Step 1: เขียน failing test**

สร้าง `src/crypto/__tests__/subkeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { driveSaltFromFolderId, deriveDriveSubkeys, hmacNameFor } from '../subkeys';
import { deriveKey, exportKeyRaw, seal, open } from '../index';

const FOLDER = 'folder_abc123';

describe('drive subkeys', () => {
    it('salt deterministic จาก folderId (SHA-256 ของ namespace + folderId)', async () => {
        const a = driveSaltFromFolderId(FOLDER);
        const b = driveSaltFromFolderId(FOLDER);
        const c = driveSaltFromFolderId('folder_อื่น');
        expect([...a]).toEqual([...b]);
        expect([...a]).not.toEqual([...c]);
        expect(a.byteLength).toBe(16); // ใช้ 16 ไบต์แรกของ digest ให้เข้ากับ SALT_BYTES เดิม
    });

    it('passphrase + folderId เดียวกัน → subkeys เดียวกัน (cross-device)', async () => {
        const { key: k1 } = await deriveKey('Zzz-pass', driveSaltFromFolderId(FOLDER), { extractable: true });
        const { key: k2 } = await deriveKey('Zzz-pass', driveSaltFromFolderId(FOLDER), { extractable: true });
        const s1 = await deriveDriveSubkeys(await exportKeyRaw(k1), FOLDER);
        const s2 = await deriveDriveSubkeys(await exportKeyRaw(k2), FOLDER);
        expect(await hmacNameFor(s1.blobName, 'hash1')).toBe(await hmacNameFor(s2.blobName, 'hash1'));
        const boxed = await seal(s1.blobEnc, new TextEncoder().encode('x'));
        expect(new TextDecoder().decode(await open(s2.blobEnc, boxed))).toBe('x');
    });

    it('domain separation — ชื่อ blob ไม่เท่ากับ raw hash และคนละ label คนละค่า', async () => {
        const { key } = await deriveKey('Zzz-pass', driveSaltFromFolderId(FOLDER), { extractable: true });
        const s = await deriveDriveSubkeys(await exportKeyRaw(key), FOLDER);
        const name = await hmacNameFor(s.blobName, 'deadbeef'.repeat(8));
        expect(name).toMatch(/^[0-9a-f]{64}$/);
        expect(name).not.toBe('deadbeef'.repeat(8));
    });
});
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/crypto/__tests__/subkeys.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement subkeys.ts**

```ts
// src/crypto/subkeys.ts
const encoder = new TextEncoder();

/** Salt ของ Drive backend — derive จาก folderId (ไม่ใช่ความลับ แต่ต้อง deterministic ทุกเครื่อง) */
export function driveSaltFromFolderId(folderId: string): Uint8Array {
    // sync SHA-256 ไม่มีใน WebCrypto — ใช้ async ผ่าน helper ด้านล่างแทน ถ้าต้องการ sync ให้ precompute
    throw new Error('use driveSaltFromFolderIdAsync');
}

export async function driveSaltFromFolderIdAsync(folderId: string): Promise<Uint8Array> {
    const d = await crypto.subtle.digest('SHA-256', encoder.encode(`TavernSync/account-salt/v1:${folderId}`));
    return new Uint8Array(d).slice(0, 16);
}

export interface DriveSubkeys {
    manifestEnc: CryptoKey;
    blobEnc: CryptoKey;
    blobName: CryptoKey;
}

async function hkdf(rootRaw: Uint8Array, folderId: string, info: string, keyType: 'aes' | 'hmac'): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', rootRaw as BufferSource, 'HKDF', false, ['deriveKey']);
    const salt = encoder.encode(`TavernSync/hkdf-salt/v1:${folderId}`);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: encoder.encode(info) as BufferSource },
        base,
        keyType === 'aes' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256' },
        false,
        keyType === 'aes' ? ['encrypt', 'decrypt'] : ['sign'],
    );
}

export function deriveDriveSubkeys(rootKeyRaw: Uint8Array, folderId: string): Promise<DriveSubkeys> {
    return Promise.all([
        hkdf(rootKeyRaw, folderId, 'manifest-enc', 'aes'),
        hkdf(rootKeyRaw, folderId, 'blob-enc', 'aes'),
        hkdf(rootKeyRaw, folderId, 'blob-name', 'hmac'),
    ]).then(([manifestEnc, blobEnc, blobName]) => ({ manifestEnc, blobEnc, blobName }));
}

export async function hmacNameFor(blobNameKey: CryptoKey, contentHash: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', blobNameKey, encoder.encode(contentHash) as BufferSource);
    return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

แก้ test ให้ใช้ `driveSaltFromFolderIdAsync` (ลบ sync version ทิ้งจากทั้งโค้ดและเทส — ปรับใน Step 4)

- [ ] **Step 4: ปรับเทสให้ await async salt แล้วรันให้ผ่าน**

แก้ `subkeys.test.ts`: ทุกจุดที่เรียก `driveSaltFromFolderId(...)` → `await driveSaltFromFolderIdAsync(...)` (และลบ sync stub ออกจาก subkeys.ts)

Run: `npm test -- src/crypto/__tests__/subkeys.test.ts`
Expected: PASS 3 เคส

- [ ] **Step 5: Commit**

```bash
git add src/crypto/subkeys.ts src/crypto/__tests__/subkeys.test.ts
git commit -m "feat(crypto): HKDF subkeys + folderId-derived salt for Drive backend"
```

---

### Task 4: Drive API client ระดับล่าง (mock fetch)

**Files:**
- Create: `src/backend/drive/client.ts`
- Test: `src/backend/drive/__tests__/client.test.ts` (สร้างใหม่)

**Interfaces:**
- Produces (ให้ Task 5-6 ใช้):

```ts
export interface DriveFileMeta {
    id: string;
    name: string;
    size?: number;
    createdTime?: string;
    appProperties?: Record<string, string>;
}
export interface DriveTokenProvider { getToken(): Promise<string>; }

export class DriveClient {
    constructor(tp: DriveTokenProvider);
    listChildren(parentId: string, opts?: { namePrefix?: string }): Promise<DriveFileMeta[]>; // paginate 1000/หน้า, trashed=false, fields เฉพาะที่จำเป็น
    findChildByName(parentId: string, name: string): Promise<DriveFileMeta | null>;
    createFolder(name: string, appProperties: Record<string, string>): Promise<DriveFileMeta>;
    createFile(parentId: string, name: string, data: Uint8Array, appProperties?: Record<string, string>): Promise<DriveFileMeta>; // multipart ≤5MB, resumable >5MB
    getFileData(id: string): Promise<Uint8Array>;
    trashFile(id: string): Promise<void>;
    getQuota(): Promise<{ usedBytes: number; limitBytes: number }>; // about.get?fields=storageQuota
}
```

- [ ] **Step 1: เขียน failing test (mock fetch ระดับ HTTP)**

สร้าง `src/backend/drive/__tests__/client.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DriveClient } from '../client';

const tp = { getToken: async () => 'tok' };

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
}

describe('DriveClient', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('listChildren รวมทุกหน้า (paging) และใส่ parent + trashed=false ใน query', async () => {
        const seen: string[] = [];
        stubFetch(async (url) => {
            seen.push(String(url));
            if (seen.length === 1) {
                return new Response(JSON.stringify({ files: [{ id: 'a', name: 'x' }], nextPageToken: 'p2' }), { status: 200 });
            }
            return new Response(JSON.stringify({ files: [{ id: 'b', name: 'y' }] }), { status: 200 });
        });
        const c = new DriveClient(tp);
        const files = await c.listChildren('parent1');
        expect(files.map(f => f.id)).toEqual(['a', 'b']);
        expect(seen[0]).toContain('pageToken');
        expect(decodeURIComponent(seen[0])).toContain("'parent1' in parents");
        expect(decodeURIComponent(seen[0])).toContain('trashed=false');
        expect(seen[1]).toContain('pageToken=p2');
    });

    it('createFile เล็กใช้ multipart; ใหญ่กว่า 5MB ใช้ resumable (initiate แล้ว PUT)', async () => {
        const urls: string[] = [];
        stubFetch(async (url, init) => {
            urls.push(`${init?.method ?? 'GET'} ${url}`);
            if (String(url).includes('uploadType=resumable') && init?.method === 'POST') {
                return new Response('', { status: 200, headers: { Location: 'https://upload/session1' } });
            }
            return new Response(JSON.stringify({ id: 'f1', name: 'n' }), { status: 200 });
        });
        const c = new DriveClient(tp);
        await c.createFile('p', 'small', new Uint8Array(100));
        await c.createFile('p', 'big', new Uint8Array(6 * 1024 * 1024));
        expect(urls[0]).toContain('uploadType=multipart');
        expect(urls.some(u => u.includes('uploadType=resumable') && u.startsWith('POST'))).toBe(true);
        expect(urls.some(u => u === 'PUT https://upload/session1')).toBe(true);
    });

    it('getQuota อ่าน storageQuota; ถ้าไม่มี limit คืน 0', async () => {
        stubFetch(async () => new Response(JSON.stringify({ storageQuota: { usage: '10', limit: '20' } }), { status: 200 }));
        const c = new DriveClient(tp);
        expect(await c.getQuota()).toEqual({ usedBytes: 10, limitBytes: 20 });
        stubFetch(async () => new Response(JSON.stringify({ storageQuota: { usage: '10' } }), { status: 200 }));
        expect(await c.getQuota()).toEqual({ usedBytes: 10, limitBytes: 0 });
    });

    it('401 จาก Drive โยน DriveAuthError (ให้ UI เด้ง reconnect)', async () => {
        stubFetch(async () => new Response('{}', { status: 401 }));
        const c = new DriveClient(tp);
        await expect(c.getQuota()).rejects.toMatchObject({ name: 'DriveAuthError' });
    });
});
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/drive/__tests__/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement client.ts**

```ts
// src/backend/drive/client.ts
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MULTIPART_LIMIT = 5 * 1024 * 1024;

export class DriveAuthError extends Error {
    constructor() { super('Google authorization expired or revoked'); this.name = 'DriveAuthError'; }
}

export interface DriveFileMeta {
    id: string; name: string; size?: number; createdTime?: string;
    appProperties?: Record<string, string>;
}
export interface DriveTokenProvider { getToken(): Promise<string>; }

export class DriveClient {
    constructor(private tp: DriveTokenProvider) {}

    private async req(url: string, init: RequestInit = {}, raw = false): Promise<Response> {
        const token = await this.tp.getToken();
        const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
        if (res.status === 401) throw new DriveAuthError();
        if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text().catch(() => '')}`);
        return res;
    }

    async listChildren(parentId: string): Promise<DriveFileMeta[]> {
        const out: DriveFileMeta[] = [];
        let pageToken = '';
        do {
            const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
            const fields = encodeURIComponent('nextPageToken, files(id,name,size,createdTime,appProperties)');
            const url = `${API}/files?q=${q}&fields=${fields}&pageSize=1000&pageToken=${pageToken}`;
            const data = await (await this.req(url)).json();
            out.push(...(data.files ?? []));
            pageToken = data.nextPageToken ?? '';
        } while (pageToken);
        return out;
    }

    async findChildByName(parentId: string, name: string): Promise<DriveFileMeta | null> {
        const q = encodeURIComponent(`'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
        const fields = encodeURIComponent('files(id,name,size,createdTime,appProperties)');
        const data = await (await this.req(`${API}/files?q=${q}&fields=${fields}&pageSize=10`)).json();
        return (data.files ?? [])[0] ?? null;
    }

    async createFolder(name: string, appProperties: Record<string, string>): Promise<DriveFileMeta> {
        const res = await this.req(`${API}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', appProperties }),
        });
        return res.json();
    }

    async createFile(parentId: string, name: string, data: Uint8Array, appProperties?: Record<string, string>): Promise<DriveFileMeta> {
        const meta = { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
        if (data.byteLength <= MULTIPART_LIMIT) {
            const boundary = 'tsync_' + Math.random().toString(16).slice(2);
            const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
            const tail = `\r\n--${boundary}--`;
            const body = new Uint8Array(head.length + data.byteLength + tail.length);
            body.set(new TextEncoder().encode(head), 0);
            body.set(data, head.length);
            body.set(new TextEncoder().encode(tail), head.length + data.byteLength);
            const res = await this.req(`${UPLOAD}/files?uploadType=multipart`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body: body as unknown as BodyInit,
            });
            return res.json();
        }
        // resumable: initiate → PUT session
        const init = await this.req(`${UPLOAD}/files?uploadType=resumable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta),
        });
        const session = init.headers.get('Location');
        if (!session) throw new Error('resumable upload: no session URL');
        const res = await this.req(session, { method: 'PUT', body: data as unknown as BodyInit });
        return res.json();
    }

    async getFileData(id: string): Promise<Uint8Array> {
        const res = await this.req(`${API}/files/${id}?alt=media`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async trashFile(id: string): Promise<void> {
        await this.req(`${API}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    }

    async getQuota(): Promise<{ usedBytes: number; limitBytes: number }> {
        const data = await (await this.req(`${API}/about?fields=storageQuota`)).json();
        return { usedBytes: Number(data.storageQuota?.usage ?? 0), limitBytes: Number(data.storageQuota?.limit ?? 0) };
    }
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `npm test -- src/backend/drive/__tests__/client.test.ts`
Expected: PASS 4 เคส (ถ้าเทส paging fail ให้เช็กว่า listChildren ใส่ `pageToken=` เสมอแม้รอบแรก — ปรับเทสหรือโค้ดให้ตรงกัน โดยยึดว่า query ต้องมี parents + trashed=false)

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/client.ts src/backend/drive/__tests__/client.test.ts
git commit -m "feat(drive): low-level Drive API client (list/upload/quota) with mocked tests"
```

---

### Task 5: DriveAdapter — folders + blobs + quota

**Files:**
- Create: `src/backend/drive/adapter.ts`
- Test: `src/backend/drive/__tests__/adapter-blobs.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: `DriveClient` (Task 4), `StorageAdapter/RemoteSnapshot` (Task 1), `BackendCrypto` (Task 2)
- Produces:

```ts
export interface DriveLayout { rootId: string; manifestsId: string; blobsId: string; }

export class DriveAdapter implements StorageAdapter {
    constructor(client: DriveClient, crypto: BackendCrypto, layout: DriveLayout);
    getSnapshot(): Promise<RemoteSnapshot>;          // implement ใน Task 6 — task นี้ stub throw
    putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }>; // Task 6
    checkBlobs(hashes: string[]): Promise<string[]>;  // hashes = logical hash; แปลง HMAC ภายใน
    getBlob(hash: string): Promise<Uint8Array>;
    putBlob(hash: string, data: Uint8Array): Promise<void>;
    quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }>;
}

export async function discoverDriveLayout(client: DriveClient): Promise<DriveLayout>;
// หา root ด้วย appProperties ts=root-v1; ไม่เจอ→สร้าง; เจอหลายอัน→throw MultipleRootsError (UI เด้งให้เลือกใน Task 8)
export class MultipleRootsError extends Error { constructor(public roots: DriveFileMeta[]) { super('multiple TavernSync roots'); this.name = 'MultipleRootsError'; } }
```

- [ ] **Step 1: เขียน failing test**

สร้าง `src/backend/drive/__tests__/adapter-blobs.test.ts` (mock DriveClient ตรง ๆ ไม่ผ่าน fetch):

```ts
import { describe, expect, it, vi } from 'vitest';
import { DriveAdapter, discoverDriveLayout, MultipleRootsError } from '../adapter';
import type { DriveClient, DriveFileMeta } from '../client';
import type { BackendCrypto } from '../../runtime';

const cryptoStub: BackendCrypto = {
    encryptBlob: async d => d,
    decryptBlob: async d => d,
    encodeManifest: async m => new TextEncoder().encode(JSON.stringify(m)),
    decodeManifest: async d => JSON.parse(new TextDecoder().decode(d)),
    blobNameFor: async h => 'hmac_' + h,
};

function clientStub(files: DriveFileMeta[]): DriveClient {
    return {
        listChildren: vi.fn(async () => files),
        findChildByName: vi.fn(async (_p: string, name: string) => files.find(f => f.name === name) ?? null),
        createFolder: vi.fn(async (name: string) => ({ id: 'new_' + name, name })),
        createFile: vi.fn(async (_p: string, name: string) => ({ id: 'up_' + name, name })),
        getFileData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        trashFile: vi.fn(async () => {}),
        getQuota: vi.fn(async () => ({ usedBytes: 5, limitBytes: 15 })),
    } as unknown as DriveClient;
}

describe('DriveAdapter blobs', () => {
    const layout = { rootId: 'r', manifestsId: 'm', blobsId: 'b' };

    it('checkBlobs แปลง logical hash เป็น HMAC แล้วเทียบกับไฟล์ใน blobs/', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        expect(await a.checkBlobs(['aaa', 'bbb'])).toEqual(['bbb']);
        expect(client.listChildren).toHaveBeenCalledWith('b');
    });

    it('putBlob ข้ามถ้ามีไฟล์ชื่อเดียวกันอยู่แล้ว', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        await a.putBlob('aaa', new Uint8Array([9]));
        expect(client.createFile).not.toHaveBeenCalled();
    });

    it('getBlob หาไฟล์จากชื่อ HMAC แล้วอ่านข้อมูล', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        expect([...(await a.getBlob('aaa'))]).toEqual([1, 2, 3]);
        await expect(a.getBlob('zzz')).rejects.toThrow();
    });
});

describe('discoverDriveLayout', () => {
    it('ไม่เจอ root → สร้าง root + manifests + blobs', async () => {
        const client = clientStub([]);
        const layout = await discoverDriveLayout(client);
        expect(layout).toEqual({ rootId: 'new_TavernSync', manifestsId: 'new_manifests', blobsId: 'new_blobs' });
    });

    it('เจอหลาย root → MultipleRootsError พร้อมรายการ', async () => {
        const roots = [
            { id: 'r1', name: 'TavernSync', appProperties: { ts: 'root-v1' } },
            { id: 'r2', name: 'TavernSync', appProperties: { ts: 'root-v1' } },
        ];
        const client = {
            ...clientStub(roots),
            // root discovery ค้นทั้ง Drive (q: appProperties) ไม่ใช่ listChildren
            searchRootFolders: vi.fn(async () => roots),
        } as unknown as DriveClient;
        await expect(discoverDriveLayout(client)).rejects.toBeInstanceOf(MultipleRootsError);
    });
});
```

หมายเหตุ: root discovery ค้น**ทั้ง Drive** (ไม่ใช่ใต้ parent) — เพิ่ม method `searchRootFolders()` ใน DriveClient (Task 4 เพิ่มตอน implement task นี้):

```ts
// เพิ่มใน src/backend/drive/client.ts
async searchRootFolders(): Promise<DriveFileMeta[]> {
    const q = encodeURIComponent("appProperties has { key='ts' and value='root-v1' } and trashed=false");
    const fields = encodeURIComponent('files(id,name,appProperties)');
    const data = await (await this.req(`${API}/files?q=${q}&fields=${fields}&pageSize=100`)).json();
    return data.files ?? [];
}
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/drive/__tests__/adapter-blobs.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement adapter.ts (เฉพาะส่วน blobs/quota/discovery — snapshot ทิ้ง stub)**

```ts
// src/backend/drive/adapter.ts
import type { StorageAdapter, RemoteSnapshot, StorageRevision } from '../adapter';
import type { Manifest } from '../../sync-core/types';
import type { BackendCrypto } from '../runtime';
import { DriveClient, DriveFileMeta } from './client';

export interface DriveLayout { rootId: string; manifestsId: string; blobsId: string; }

export class MultipleRootsError extends Error {
    constructor(public roots: DriveFileMeta[]) {
        super('Multiple TavernSync root folders found');
        this.name = 'MultipleRootsError';
    }
}

export async function discoverDriveLayout(client: DriveClient): Promise<DriveLayout> {
    const roots = await client.searchRootFolders();
    if (roots.length > 1) throw new MultipleRootsError(roots);
    if (roots.length === 1) {
        const children = await client.listChildren(roots[0].id);
        const manifests = children.find(c => c.name === 'manifests');
        const blobs = children.find(c => c.name === 'blobs');
        if (!manifests || !blobs) throw new Error('TavernSync root is incomplete (missing manifests/ or blobs/)');
        return { rootId: roots[0].id, manifestsId: manifests.id, blobsId: blobs.id };
    }
    const root = await client.createFolder('TavernSync', { ts: 'root-v1' });
    const manifests = await client.createFolder('manifests', {});
    const blobs = await client.createFolder('blobs', {});
    // ย้าย subfolder เข้า root: ใช้ createFolder แบบไม่มี parent ไม่ได้ — ปรับ createFolder รับ parentId (ดูหมายเหตุ)
    return { rootId: root.id, manifestsId: manifests.id, blobsId: blobs.id };
}

export class DriveAdapter implements StorageAdapter {
    constructor(
        private client: DriveClient,
        private crypto: BackendCrypto,
        private layout: DriveLayout,
    ) {}

    async checkBlobs(hashes: string[]): Promise<string[]> {
        const files = await this.client.listChildren(this.layout.blobsId);
        const have = new Set(files.map(f => f.name));
        const missing: string[] = [];
        for (const h of hashes) {
            if (!have.has(await this.crypto.blobNameFor(h))) missing.push(h);
        }
        return missing;
    }

    async getBlob(hash: string): Promise<Uint8Array> {
        const name = await this.crypto.blobNameFor(hash);
        const f = await this.client.findChildByName(this.layout.blobsId, name);
        if (!f) throw new Error(`blob not found: ${hash}`);
        return this.client.getFileData(f.id);
    }

    async putBlob(hash: string, data: Uint8Array): Promise<void> {
        const name = await this.crypto.blobNameFor(hash);
        if (await this.client.findChildByName(this.layout.blobsId, name)) return; // content-addressed: มีแล้วข้าม
        await this.client.createFile(this.layout.blobsId, name, data);
    }

    async quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }> {
        const q = await this.client.getQuota();
        const blobs = await this.client.listChildren(this.layout.blobsId);
        return { ...q, itemCount: blobs.length };
    }

    // Task 6 จะ implement จริง
    async getSnapshot(): Promise<RemoteSnapshot> { throw new Error('not implemented (Task 6)'); }
    async putManifest(_m: Manifest, _r: StorageRevision): Promise<{ revision: StorageRevision }> { throw new Error('not implemented (Task 6)'); }
}
```

**หมายเหตุ implementation:** `createFolder` ใน client (Task 4) ต้องรับ `parentId?: string` ด้วย — แก้ signature เป็น `createFolder(name: string, appProperties: Record<string, string>, parentId?: string)` ใส่ `parents: parentId ? [parentId] : []` ใน metadata และปรับเทส discovery ให้สร้าง subfolder ใต้ root (`new_manifests`/`new_blobs` ควรถูกสร้างด้วย parent = rootId — อัปเดต clientStub ให้รับ parent เป็น arg แรกตาม signature จริง)

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `npm test -- src/backend/drive/__tests__/`
Expected: PASS ทั้ง client + adapter-blobs

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/adapter.ts src/backend/drive/client.ts src/backend/drive/__tests__/adapter-blobs.test.ts
git commit -m "feat(drive): adapter blobs/quota + folder discovery with multi-root guard"
```

---

### Task 6: Manifest commits — getSnapshot (single/fork) + putManifest + retention read-side

**Files:**
- Modify: `src/backend/drive/adapter.ts`
- Create: `src/backend/drive/commits.ts`
- Test: `src/backend/drive/__tests__/commits.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: ทุกอย่างจาก Task 1-5
- Produces:

```ts
// src/backend/drive/commits.ts
export interface CommitMeta { id: string; commitId: string; parents: string[]; createdTime: string; }
export function parseCommitMeta(f: DriveFileMeta): CommitMeta;          // อ่าน name + appProperties p0..p3
export function computeHeads(commits: CommitMeta[]): CommitMeta[];      // commit ที่ไม่มีใครชี้เป็น parent
export function revisionOfHeads(heads: CommitMeta[]): Promise<StorageRevision>; // SHA-256 ของ commitId เรียงลำดับต่อกัน
export function findCommonAncestor(a: CommitMeta, b: CommitMeta, all: CommitMeta[]): CommitMeta | null; // BFS ย้อน parent สองฝั่งหาจุดเจอกัน
export const MAX_PARENTS = 4;
```

- กฎ putManifest: heads เปลี่ยนจากตอนอ่าน → `ConflictError`; ผ่าน → สร้าง commit ใหม่ (appProperties `ts=commit-v1`, `p0..p3` = parent ids); **ถ้า heads > 4 → สร้าง merge commits กลางเป็นลำดับ (commit กลางมี manifest เดียวกับ merged result, parents กลุ่มละ ≤4) จนเหลือ head เดียว** — การจัดโครง commit เท่านั้น ไม่เลือกเนื้อหา

- [ ] **Step 1: เขียน failing test**

สร้าง `src/backend/drive/__tests__/commits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCommitMeta, computeHeads, revisionOfHeads, findCommonAncestor, type CommitMeta } from '../commits';

function commit(commitId: string, parents: string[] = []): CommitMeta {
    return { id: 'file_' + commitId, commitId, parents, createdTime: '2026-08-06T00:00:00Z' };
}

describe('commit graph', () => {
    it('parseCommitMeta อ่าน p0..p3 และเช็ก marker ts=commit-v1', () => {
        const m = parseCommitMeta({
            id: 'f1', name: 'a'.repeat(32) + '.enc',
            appProperties: { ts: 'commit-v1', p0: 'b'.repeat(32), p1: 'c'.repeat(32) },
        });
        expect(m.commitId).toBe('a'.repeat(32));
        expect(m.parents).toEqual(['b'.repeat(32), 'c'.repeat(32)]);
    });

    it('computeHeads คืน commit ที่ไม่มีใครชี้เป็น parent', () => {
        const c1 = commit('1'.repeat(32));
        const c2 = commit('2'.repeat(32), ['1'.repeat(32)]);
        const c3 = commit('3'.repeat(32), ['1'.repeat(32)]);
        const heads = computeHeads([c1, c2, c3]);
        expect(heads.map(h => h.commitId).sort()).toEqual(['2'.repeat(32), '3'.repeat(32)]);
    });

    it('revisionOfHeads deterministic และเปลี่ยนตามชุด heads', async () => {
        const c2 = commit('2'.repeat(32));
        const c3 = commit('3'.repeat(32));
        expect(await revisionOfHeads([c2, c3])).toBe(await revisionOfHeads([c3, c2])); // เรียงก่อน hash
        expect(await revisionOfHeads([c2])).not.toBe(await revisionOfHeads([c2, c3]));
    });

    it('findCommonAncestor หาจุดแยกของ fork', () => {
        const base = commit('0'.repeat(32));
        const a = commit('a'.repeat(32), ['0'.repeat(32)]);
        const b = commit('b'.repeat(32), ['0'.repeat(32)]);
        const found = findCommonAncestor(a, b, [base, a, b]);
        expect(found?.commitId).toBe('0'.repeat(32));
    });

    it('findCommonAncestor กรณีไม่มีจุดร่วม คืน null', () => {
        const a = commit('a'.repeat(32));
        const b = commit('b'.repeat(32));
        expect(findCommonAncestor(a, b, [a, b])).toBeNull();
    });
});
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/drive/__tests__/commits.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement commits.ts**

```ts
// src/backend/drive/commits.ts
import type { StorageRevision } from '../adapter';
import type { DriveFileMeta } from './client';

export const MAX_PARENTS = 4;
export const COMMIT_ID_LEN = 32; // hex chars

export interface CommitMeta { id: string; commitId: string; parents: string[]; createdTime: string; }

export function parseCommitMeta(f: DriveFileMeta): CommitMeta {
    if (f.appProperties?.ts !== 'commit-v1') throw new Error(`not a commit file: ${f.name}`);
    const parents: string[] = [];
    for (let i = 0; i < MAX_PARENTS; i++) {
        const p = f.appProperties[`p${i}`];
        if (p) parents.push(p);
    }
    return { id: f.id, commitId: f.name.replace(/\.enc$/, ''), parents, createdTime: f.createdTime ?? '' };
}

export function computeHeads(commits: CommitMeta[]): CommitMeta[] {
    const referenced = new Set(commits.flatMap(c => c.parents));
    return commits.filter(c => !referenced.has(c.commitId));
}

export async function revisionOfHeads(heads: CommitMeta[]): Promise<StorageRevision> {
    const joined = heads.map(h => h.commitId).sort().join('');
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined) as BufferSource);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function findCommonAncestor(a: CommitMeta, b: CommitMeta, all: CommitMeta[]): CommitMeta | null {
    const byId = new Map(all.map(c => [c.commitId, c]));
    const seenFromA = new Set<string>();
    const queue: string[] = [a.commitId];
    while (queue.length) {
        const id = queue.shift()!;
        if (seenFromA.has(id)) continue;
        seenFromA.add(id);
        for (const p of byId.get(id)?.parents ?? []) queue.push(p);
    }
    // BFS จาก b หาตัวแรกที่ a เคยไปถึง
    const queueB: string[] = [b.commitId];
    const seenB = new Set<string>();
    while (queueB.length) {
        const id = queueB.shift()!;
        if (seenB.has(id)) continue;
        seenB.add(id);
        if (seenFromA.has(id)) return byId.get(id) ?? null;
        for (const p of byId.get(id)?.parents ?? []) queueB.push(p);
    }
    return null;
}
```

- [ ] **Step 4: implement getSnapshot/putManifest ใน adapter.ts**

เพิ่มใน `DriveAdapter` (แทน stub):

```ts
private async listCommits(): Promise<CommitMeta[]> {
    const files = await this.client.listChildren(this.layout.manifestsId);
    return files
        .filter(f => f.appProperties?.ts === 'commit-v1' && f.name.endsWith('.enc'))
        .map(parseCommitMeta);
}

private async loadCommitManifest(c: CommitMeta): Promise<Manifest> {
    const data = await this.client.getFileData(c.id);
    return this.crypto.decodeManifest(data);
}

async getSnapshot(): Promise<RemoteSnapshot> {
    const commits = await this.listCommits();
    const heads = computeHeads(commits);
    if (heads.length === 0) return { kind: 'single', manifest: null, revision: '0' };
    const revision = await revisionOfHeads(heads);
    if (heads.length === 1) {
        return { kind: 'single', manifest: await this.loadCommitManifest(heads[0]), revision };
    }
    // fork: โหลด manifest ทุก head + หา common ancestor ของ head คู่แรก (N>2 ให้ engine merge ทีละก้อน)
    const headManifests = await Promise.all(heads.map(async h => ({ commitId: h.commitId, manifest: await this.loadCommitManifest(h) })));
    const anc = findCommonAncestor(heads[0], heads[1], commits);
    const commonAncestor = anc ? await this.loadCommitManifest(anc) : null;
    return { kind: 'fork', heads: headManifests, commonAncestor, revision };
}

async putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }> {
    const commits = await this.listCommits();
    let heads = computeHeads(commits);
    const current = heads.length ? await revisionOfHeads(heads) : '0';
    if (current !== ifRevision) throw new ConflictError();

    const data = await this.crypto.encodeManifest(m);
    // ถ้า heads > MAX_PARENTS: สร้าง merge commit กลางเป็นลำดับ (manifest เดียวกัน) จนเหลือ ≤4 parents
    while (heads.length > MAX_PARENTS) {
        const group = heads.slice(0, MAX_PARENTS);
        const id = await this.writeCommit(data, group.map(h => h.commitId));
        heads = [{ id, commitId: id.replace(/^file_/, ''), parents: group.map(h => h.commitId), createdTime: '' }, ...heads.slice(MAX_PARENTS)];
        // หมายเหตุ: writeCommit คืน commitId ของไฟล์ใหม่ — ใช้ตรง ๆ
    }
    const commitId = await this.writeCommit(data, heads.map(h => h.commitId));
    return { revision: await revisionOfHeads([{ id: commitId, commitId, parents: [], createdTime: '' }]) };
}

private async writeCommit(data: Uint8Array, parents: string[]): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const commitId = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, COMMIT_ID_LEN);
    const appProperties: Record<string, string> = { ts: 'commit-v1' };
    parents.slice(0, MAX_PARENTS).forEach((p, i) => { appProperties[`p${i}`] = p; });
    await this.client.createFile(this.layout.manifestsId, `${commitId}.enc`, data, appProperties);
    return commitId;
}
```

อย่าลืม `import { ConflictError } from '../adapter';`

- [ ] **Step 5: เพิ่มเทส snapshot/putManifest (fork detection + conflict)**

ต่อท้าย `src/backend/drive/__tests__/commits.test.ts`:

```ts
describe('DriveAdapter manifest commits', () => {
    it('putManifest เมื่อ revision ไม่ตรง → ConflictError', async () => {
        const { DriveAdapter } = await import('../adapter');
        // client ที่มี commit c1 อยู่แล้ว (revision ≠ '0')
        // ... ใช้ clientStub จาก adapter-blobs.test.ts pattern เดียวกัน:
        // listChildren(manifestsId) คืน [{name: '<32hex>.enc', appProperties: {ts:'commit-v1'}, createdTime}]
        // getFileData คืน encodeManifest(manifest เดิม)
        // expect putManifest(m, '0') → rejects ConflictError
    });

    it('push ครั้งแรก (ไม่มี commit) ใช้ ifRevision "0" สร้าง commit แรกสำเร็จ', async () => {
        // client ว่าง → putManifest(m, '0') → createFile ถูกเรียกด้วยชื่อ <32hex>.enc + appProperties ts=commit-v1 ไม่มี p0
    });

    it('getSnapshot เจอ 2 heads → kind fork พร้อม heads + commonAncestor', async () => {
        // เตรียม commits: base → headA, headB (ทั้งคู่ parent=base)
        // คาด snapshot.kind === 'fork', heads.length === 2, commonAncestor ไม่ null
    });
});
```

(Implementer: เติม body เทส 3 ก้อนนี้ด้วย clientStub แบบเดียวกับ Task 5 Step 1 — ห้ามปล่อยเทสว่าง)

- [ ] **Step 6: รันเทสทั้งหมดให้ผ่าน**

Run: `npm test`
Expected: PASS ทั้งหมด

- [ ] **Step 7: Commit**

```bash
git add src/backend/drive/
git commit -m "feat(drive): immutable manifest commits with fork snapshot + revision check"
```

---

### Task 7: Engine fork orchestration — merge 3 ทางผ่าน sync-core

**Files:**
- Create: `src/sync-core/merge.ts`
- Test: `src/sync-core/__tests__/merge.test.ts` (สร้างใหม่)
- Modify: `src/sync/engine.ts` (runSync รับ fork snapshot, เรียก merge, ส่ง conflict เข้า resolveConflicts เดิม)

**Interfaces:**
- Consumes: `RemoteSnapshot` (Task 1), `DiffEntry/ConflictChoice` เดิม, `resolveConflicts` callback ที่มีอยู่ใน runSync (engine.ts:434)
- Produces:

```ts
// src/sync-core/merge.ts (pure — ห้ามแตะ ST/DOM)
export interface MergeResult {
    merged: Record<string, SyncItem>;
    conflicts: DiffEntry[];  // รูปแบบเดียวกับ diffManifests เพื่อเข้า conflict UI เดิม
}
export function mergeManifestItems(
    ancestor: Record<string, SyncItem>,
    a: Record<string, SyncItem>,
    b: Record<string, SyncItem>,
): MergeResult;
```

- กฎ merge ต่อ item id (ห้ามใช้ mtime ตัดสิน):
  - `a === ancestor, b เปลี่ยน` → เอา b (และกลับกัน)
  - `a === b` → เอาอันนั้น
  - ทั้งคู่เปลี่ยนคนละ hash / ฝั่งหนึ่งลบอีกฝั่งแก้ → conflict (DiffEntry action 'conflict', local=a, remote=b, base=ancestor)
  - ทั้งคู่ลบ → ลบ

- [ ] **Step 1: เขียน failing test**

สร้าง `src/sync-core/__tests__/merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeManifestItems } from '../merge';
import type { SyncItem } from '../types';

function item(id: string, hash: string): SyncItem { return { id, type: 'worldinfo', hash, size: 1, mtime: 1 }; }

describe('mergeManifestItems (3-way)', () => {
    it('แก้ฝั่งเดียว → รับฝั่งนั้น', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const a = { 'w/a': item('w/a', 'h1') };
        const b = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, a, b);
        expect(r.merged['w/a'].hash).toBe('h1');
        expect(r.conflicts).toHaveLength(0);
    });

    it('ทั้งสองฝั่ง hash เดียวกัน → ไม่ conflict', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, { 'w/a': item('w/a', 'h9') }, { 'w/a': item('w/a', 'h9') });
        expect(r.conflicts).toHaveLength(0);
        expect(r.merged['w/a'].hash).toBe('h9');
    });

    it('แก้ชนกันคนละ hash → conflict พร้อม local/remote/base', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, { 'w/a': item('w/a', 'h1') }, { 'w/a': item('w/a', 'h2') });
        expect(r.conflicts).toHaveLength(1);
        expect(r.conflicts[0]).toMatchObject({ id: 'w/a', action: 'conflict' });
        expect(r.conflicts[0].local?.hash).toBe('h1');
        expect(r.conflicts[0].remote?.hash).toBe('h2');
        expect(r.conflicts[0].base?.hash).toBe('h0');
    });

    it('delete ชน edit → conflict', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, {}, { 'w/a': item('w/a', 'h2') });
        expect(r.conflicts).toHaveLength(1);
    });

    it('item ใหม่คนละฝั่ง → union ทั้งคู่ ไม่ conflict', () => {
        const r = mergeManifestItems({}, { 'w/a': item('w/a', 'h1') }, { 'w/b': item('w/b', 'h2') });
        expect(Object.keys(r.merged).sort()).toEqual(['w/a', 'w/b']);
        expect(r.conflicts).toHaveLength(0);
    });

    it('ทั้งคู่ลบ → ไม่อยู่ใน merged', () => {
        const anc = { 'w/a': item('w/a', 'h0') };
        const r = mergeManifestItems(anc, {}, {});
        expect(r.merged['w/a']).toBeUndefined();
        expect(r.conflicts).toHaveLength(0);
    });
});
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/sync-core/__tests__/merge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement merge.ts**

```ts
// src/sync-core/merge.ts
import type { DiffEntry, SyncItem } from './types';

export interface MergeResult {
    merged: Record<string, SyncItem>;
    conflicts: DiffEntry[];
}

/** 3-way merge ต่อ item — ห้ามใช้ mtime ตัดสิน conflict */
export function mergeManifestItems(
    ancestor: Record<string, SyncItem>,
    a: Record<string, SyncItem>,
    b: Record<string, SyncItem>,
): MergeResult {
    const merged: Record<string, SyncItem> = {};
    const conflicts: DiffEntry[] = [];
    const ids = new Set([...Object.keys(ancestor), ...Object.keys(a), ...Object.keys(b)]);
    for (const id of ids) {
        const base = ancestor[id];
        const ai = a[id];
        const bi = b[id];
        const aChanged = (ai?.hash ?? null) !== (base?.hash ?? null);
        const bChanged = (bi?.hash ?? null) !== (base?.hash ?? null);
        if (!aChanged && !bChanged) { if (base) merged[id] = base; continue; }
        if (aChanged && !bChanged) { if (ai) merged[id] = ai; continue; }
        if (!aChanged && bChanged) { if (bi) merged[id] = bi; continue; }
        // ทั้งคู่เปลี่ยน
        if ((ai?.hash ?? null) === (bi?.hash ?? null)) { if (ai) merged[id] = ai; continue; }
        conflicts.push({ id, action: 'conflict', type: ai?.type ?? bi?.type ?? base?.type, local: ai, remote: bi, base });
    }
    return { merged, conflicts };
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `npm test -- src/sync-core/__tests__/merge.test.ts`
Expected: PASS 6 เคส

- [ ] **Step 5: engine.ts — รับ fork snapshot ใน runSync**

ที่ runSync (engine.ts ~469) แทนบล็อก `fork unsupported` ชั่วคราวจาก Task 1:

```ts
const snap = await adapter.getSnapshot();
let remote: Manifest | null;
let remoteRevision: StorageRevision;
if (snap.kind === 'single') {
    remote = snap.manifest;
    remoteRevision = snap.revision;
} else {
    // fork: merge heads ทีละก้อนด้วย mergeManifestItems + conflict UI เดิม
    let accItems: Record<string, SyncItem> = snap.commonAncestor?.items ?? {};
    let accManifest: Manifest | null = snap.commonAncestor;
    for (const head of snap.heads) {
        const ancestor = accItems;
        const r = mergeManifestItems(ancestor, accManifest?.items ?? {}, head.manifest.items);
        if (r.conflicts.length && opts.resolveConflicts) {
            const choices = await opts.resolveConflicts(r.conflicts, 'pull');
            for (const c of r.conflicts) {
                const choice = choices.get(c.id);
                if (choice === 'keep_local') { if (c.local) r.merged[c.id] = c.local; }
                else if (choice === 'keep_server') { if (c.remote) r.merged[c.id] = c.remote; }
                else if (choice === 'keep_both') { /* engine มี conflictSiblingId อยู่แล้ว — ใช้ที่นั่นตอน apply */ if (c.remote) r.merged[c.id] = c.remote; }
                // 'skip' → เว้นไว้ (ไม่ใส่ merged)
            }
        }
        accItems = r.merged;
        accManifest = { ...(snap.heads[0].manifest), items: accItems };
    }
    remote = accManifest;
    remoteRevision = snap.revision;
}
```

เช็ก `ConflictChoice` type เดิมใน engine/ui/conflict.ts ว่าค่าที่รับคืออะไร ('keep_local'/'keep_server'/...) แล้วปรับ mapping ให้ตรงของจริง — อ่าน `src/ui/conflict.ts:8-59` ก่อนเขียน

- [ ] **Step 6: typecheck + เทสทั้งหมด**

Run: `npx tsc --noEmit` และ `npm test`
Expected: ผ่านทั้งคู่

- [ ] **Step 7: Commit**

```bash
git add src/sync-core/merge.ts src/sync-core/__tests__/merge.test.ts src/sync/engine.ts
git commit -m "feat(sync): 3-way fork merge via RemoteSnapshot + existing conflict UI"
```

---

### Task 8: Drive runtime — GIS OAuth + factory รองรับ backend selector

**Files:**
- Create: `src/backend/drive/oauth.ts`
- Modify: `src/backend/runtime.ts` (requireRuntime รองรับ backendMode 'drive')
- Modify: `src/settings.ts` (เพิ่ม fields)
- Test: `src/backend/drive/__tests__/oauth.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: ทุกอย่าง Task 1-6, `deriveDriveSubkeys/driveSaltFromFolderIdAsync/hmacNameFor` (Task 3), `deriveKey/exportKeyRaw` (crypto เดิม)
- Produces:

```ts
// src/backend/drive/oauth.ts
export interface GisTokenClient { requestAccessToken(overrides?: { prompt?: string }): void; }
export class GisTokenProvider implements DriveTokenProvider {
    constructor(clientId: string, loadGis?: () => Promise<GisTokenClient>); // inject สำหรับเทส
    getToken(): Promise<string>;   // ครั้งแรกต้องมาจาก user gesture (ปุ่ม Connect) — เก็บ token+expiry ใน memory; หมดอายุ → requestAccessToken({prompt:''}) ใน gesture ถัดไป
    revoke(): Promise<void>;
}
```

- settings เพิ่ม fields (settings.ts schema + defaultSettings):
  - `backendMode`: ขยาย type `'managed' | 'custom' | 'drive'` (เดิมมี managed/custom อยู่แล้ว settings.ts:25)
  - `driveClientId: string` (default `''`)
  - `driveFolderId: string` (default `''` — จำ root ที่เลือก/สร้างไว้ per device)

- [ ] **Step 1: เขียน failing test — token provider lifecycle**

สร้าง `src/backend/drive/__tests__/oauth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GisTokenProvider } from '../oauth';

function gisStub() {
    const calls: { prompt?: string }[] = [];
    const listeners: ((resp: { access_token?: string; error?: string; expires_in?: number }) => void)[] = [];
    return {
        calls,
        client: {
            requestAccessToken(opts?: { prompt?: string }) {
                calls.push(opts ?? {});
                listeners.forEach(fn => fn({ access_token: 'token_' + calls.length, expires_in: 3600 }));
            },
        } as never,
        setCallback(fn: (resp: { access_token?: string; error?: string; expires_in?: number }) => void) { listeners.push(fn); },
    };
}

describe('GisTokenProvider', () => {
    it('getToken ครั้งแรกขอ token ผ่าน GIS และ cache ไว้', async () => {
        const g = gisStub();
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        expect(await p.getToken()).toBe('token_1');
        expect(await p.getToken()).toBe('token_1'); // cache
        expect(g.calls).toHaveLength(1);
    });

    it('token หมดอายุ → ขอใหม่แบบ prompt ว่าง (ตอน gesture ถัดไป)', async () => {
        const g = gisStub();
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        await p.getToken();
        p.markExpiredForTest();
        expect(await p.getToken()).toBe('token_2');
        expect(g.calls[1]?.prompt).toBe('');
    });

    it('revoke ล้าง token ใน memory', async () => {
        const g = gisStub();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        await p.getToken();
        await p.revoke();
        expect(await p.getToken()).toBe('token_2');
    });
});
```

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/drive/__tests__/oauth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement oauth.ts**

```ts
// src/backend/drive/oauth.ts
import type { DriveTokenProvider } from './client';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class GisTokenProvider implements DriveTokenProvider {
    private token: string | null = null;
    private expiresAt = 0;
    private client: { requestAccessToken(o?: { prompt?: string }): void } | null = null;
    private pending: ((t: string) => void) | null = null;

    constructor(
        private clientId: string,
        private loadClient?: () => Promise<{ requestAccessToken(o?: { prompt?: string }): void }>,
        private setCallback?: (fn: (resp: { access_token?: string; error?: string; expires_in?: number }) => void) => void,
    ) {}

    /** ต้องถูกเรียกจาก user gesture (ปุ่ม Connect / Push / Pull / Test) */
    async getToken(): Promise<string> {
        if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
        const client = this.loadClient ? await this.loadClient() : await this.loadGisClient();
        return new Promise((resolve, reject) => {
            const cb = (resp: { access_token?: string; error?: string; expires_in?: number }) => {
                if (resp.access_token) {
                    this.token = resp.access_token;
                    this.expiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000;
                    resolve(this.token);
                } else {
                    reject(new Error(`Google sign-in failed: ${resp.error ?? 'unknown'}`));
                }
            };
            this.setCallback ? this.setCallback(cb) : this.registerCallback(cb);
            client.requestAccessToken({ prompt: this.token ? '' : 'consent' });
        });
    }

    async revoke(): Promise<void> {
        if (this.token) {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${this.token}`, { method: 'POST' }).catch(() => {});
        }
        this.token = null;
        this.expiresAt = 0;
    }

    markExpiredForTest(): void { this.expiresAt = 0; }

    private async loadGisClient() {
        if (this.client) return this.client;
        await new Promise<void>((resolve, reject) => {
            const s = document.createElement('script');
            s.src = GIS_SRC;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('โหลด Google Identity Services ไม่สำเร็จ'));
            document.head.appendChild(s);
        });
        const g = (window as unknown as { google: { accounts: { oauth2: {
            initTokenClient(cfg: { client_id: string; scope: string; callback: (r: { access_token?: string; error?: string; expires_in?: number }) => void }): { requestAccessToken(o?: { prompt?: string }): void };
        } } } }).google;
        this.client = g.accounts.oauth2.initTokenClient({
            client_id: this.clientId,
            scope: SCOPE,
            callback: () => {},
        });
        return this.client;
    }

    private registerCallback(cb: (resp: { access_token?: string; error?: string; expires_in?: number }) => void) {
        // GIS รับ callback ตอน initTokenClient — re-init ด้วย callback ใหม่ทุกครั้งที่ขอ token
        const g = (window as unknown as { google: { accounts: { oauth2: {
            initTokenClient(cfg: { client_id: string; scope: string; callback: (r: { access_token?: string; error?: string; expires_in?: number }) => void }): { requestAccessToken(o?: { prompt?: string }): void };
        } } } }).google;
        this.client = g.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPE, callback: cb });
    }
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `npm test -- src/backend/drive/__tests__/oauth.test.ts`
Expected: PASS 3 เคส

- [ ] **Step 5: runtime.ts — ต่อ Drive runtime เข้า factory**

เพิ่มใน `src/backend/runtime.ts`:

```ts
import { DriveClient } from './drive/client';
import { DriveAdapter, discoverDriveLayout } from './drive/adapter';
import { GisTokenProvider } from './drive/oauth';
import { deriveDriveSubkeys, driveSaltFromFolderIdAsync, hmacNameFor } from '../crypto/subkeys';
import { deriveKey, exportKeyRaw, seal, open } from '../crypto';

export function makeDriveCrypto(subkeys: { manifestEnc: CryptoKey; blobEnc: CryptoKey; blobName: CryptoKey }): BackendCrypto {
    return {
        encryptBlob: d => seal(subkeys.blobEnc, d),        // Drive runtime: E2EE บังคับ เสมอเข้ารหัส
        async decryptBlob(data, expectedPlaintextHash) {
            const pt = await open(subkeys.blobEnc, data);
            if ((await sha256Hex(pt)) !== expectedPlaintextHash) throw new Error('blob hash mismatch');
            return pt;
        },
        encodeManifest: async m => seal(subkeys.manifestEnc, new TextEncoder().encode(JSON.stringify(m))),
        decodeManifest: async d => JSON.parse(new TextDecoder().decode(await open(subkeys.manifestEnc, d))) as Manifest,
        blobNameFor: h => hmacNameFor(subkeys.blobName, h),
    };
}

class DriveSaltProvider implements SaltProvider {
    constructor(private folderId: string) {}
    async getSalt() { return driveSaltFromFolderIdAsync(this.folderId); }
    async ensureSalt(_local: Uint8Array) { return driveSaltFromFolderIdAsync(this.folderId); } // deterministic — ไม่สน local
}
```

และใน `requireRuntime()` เพิ่ม branch ก่อนของเดิม:

```ts
const s = getSettings();
if (s.backendMode === 'drive') {
    if (!s.driveClientId.trim()) throw new Error('No Google Client ID configured');
    const provider = new GisTokenProvider(s.driveClientId.trim());
    const client = new DriveClient(provider);
    const layout = await discoverDriveLayout(client); // MultipleRootsError → UI จับใน Task 9
    // sessionKey (passphrase-derived, extractable) ต้องพร้อมก่อน — engine gate อยู่แล้ว (runSync เช็ก E2EE ก่อน)
    const sk = getSessionKey();
    if (!sk) throw new Error('Drive backend บังคับ E2EE — ปลดล็อก passphrase ก่อน');
    const subkeys = await deriveDriveSubkeys(await exportKeyRaw(sk), layout.rootId);
    return {
        storage: new DriveAdapter(client, makeDriveCrypto(subkeys), layout),
        crypto: makeDriveCrypto(subkeys),
        saltProvider: new DriveSaltProvider(layout.rootId),
        storageNamespace: `drive:${layout.rootId}`,
    };
}
// ...HTTP branch เดิม
```

หมายเหตุ: root key สำหรับ Drive ต้อง derive ด้วย `driveSaltFromFolderIdAsync(folderId)` — engine `unlockE2ee` ปัจจุบัน derive ด้วย `settings.e2eeSalt`; branch Drive ต้องใส่ salt ที่ derive จาก folderId ลง settings.e2eeSalt ตอน Connect สำเร็จ (Task 9) เพื่อให้ flow unlock เดิมทำงานต่อได้โดยไม่แก้ engine เพิ่ม

- [ ] **Step 6: typecheck + เทสทั้งหมด**

Run: `npx tsc --noEmit` และ `npm test`
Expected: ผ่านทั้งคู่

- [ ] **Step 7: Commit**

```bash
git add src/backend/drive/oauth.ts src/backend/drive/__tests__/oauth.test.ts src/backend/runtime.ts src/settings.ts
git commit -m "feat(drive): GIS token provider + Drive runtime wiring in factory"
```

---

### Task 9: Panel UI — backend selector + Connect/Disconnect + Storage line + GC ปุ่ม manual

**Files:**
- Modify: `panel.html` (เพิ่ม option + ฟิลด์ใหม่)
- Modify: `src/index.ts` (bindings + handlers)
- Modify: `src/settings.ts` (hydrate/validate fields ใหม่ — ทำบางส่วนใน Task 8 แล้ว)
- Create: `src/backend/drive/gc.ts`
- Test: `src/backend/drive/__tests__/gc.test.ts` (สร้างใหม่)

**Interfaces:**
- Consumes: ทุกอย่างก่อนหน้า, panel.html ids เดิม (`#tavernsync_backend_mode` select มีอยู่แล้ว panel.html:18-21), `setStatusLine`, `updateE2eeUi` (index.ts)
- Produces:
  - `collectGarbage(client: DriveClient, adapter: DriveAdapter, layout: DriveLayout, crypto: BackendCrypto): Promise<{ trashedBlobs: number; trashedCommits: number }>` — manual GC: ห้ามรันระหว่าง fork, live set = union blob จากทุก retained commit, orphan ต้องเก่ากว่า 7 วัน, prune commits เมื่อเหลือ head เดียว (เก็บ 10 ล่าสุด)
  - panel ids ใหม่: `#tavernsync_drive_fields`, `#tavernsync_client_id`, `#tavernsync_google_connect`, `#tavernsync_google_disconnect`, `#tavernsync_gc`

- [ ] **Step 1: เขียน failing test — GC rules**

สร้าง `src/backend/drive/__tests__/gc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { collectGarbage } from '../gc';

// helper: สร้างสถานการณ์ commits/blobs ปลอม
// เคสที่ต้องมี:
// 1. มี fork (2 heads) → throw/ปฏิเสธ GC
// 2. blob ที่ไม่มี commit ไหนอ้าง + เก่ากว่า 7 วัน → ถูก trash
// 3. blob orphan แต่อายุ < 7 วัน → รอด (grace period)
// 4. blob ที่ commit ล่าสุดอ้างถึง → รอดเสมอ
// 5. เหลือ head เดียวและ chain ยาวเกิน 10 → commits เก่าสุดถูก trash เหลือ 10
```

(Implementer: เขียน body เทสทั้ง 5 เคสด้วย clientStub แบบ Task 5 — ห้ามปล่อยว่าง; blob ที่ commit อ้างถึงให้สร้าง manifest ผ่าน cryptoStub.encodeManifest แล้วใส่ items ที่มี hash ทดสอบ)

- [ ] **Step 2: รันให้ fail**

Run: `npm test -- src/backend/drive/__tests__/gc.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: implement gc.ts**

```ts
// src/backend/drive/gc.ts
import type { DriveClient } from './client';
import type { DriveAdapter, DriveLayout } from './adapter';
import type { BackendCrypto } from '../runtime';
import { parseCommitMeta, computeHeads } from './commits';

const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_COMMITS = 10;

export async function collectGarbage(
    client: DriveClient,
    adapter: DriveAdapter,
    layout: DriveLayout,
    crypto: BackendCrypto,
): Promise<{ trashedBlobs: number; trashedCommits: number }> {
    const commitFiles = (await client.listChildren(layout.manifestsId))
        .filter(f => f.appProperties?.ts === 'commit-v1')
        .map(parseCommitMeta);
    const heads = computeHeads(commitFiles);
    if (heads.length > 1) throw new Error('มี fork ค้างอยู่ — ซิงก์ให้เสร็จก่อน GC');
    if (heads.length === 0) return { trashedBlobs: 0, trashedCommits: 0 };

    // รวบรวม commits ที่ retain: walk จาก head เก็บ 10 ตัวล่าสุด
    const byId = new Map(commitFiles.map(c => [c.commitId, c]));
    const retained: typeof commitFiles = [];
    const queue = [heads[0]];
    const seen = new Set<string>();
    while (queue.length && retained.length < KEEP_COMMITS) {
        const c = queue.shift()!;
        if (seen.has(c.commitId)) continue;
        seen.add(c.commitId);
        retained.push(c);
        for (const p of c.parents) { const pc = byId.get(p); if (pc) queue.push(pc); }
    }

    // live set = union ของ blob names ที่ทุก retained commit อ้าง
    const live = new Set<string>();
    for (const c of retained) {
        const m = await crypto.decodeManifest(await client.getFileData(c.id));
        for (const item of Object.values(m.items)) {
            if (!item.deleted) live.add(await crypto.blobNameFor(item.hash));
        }
    }

    // trash blob orphan ที่เก่ากว่า grace
    let trashedBlobs = 0;
    const now = Date.now();
    for (const f of await client.listChildren(layout.blobsId)) {
        const age = now - Date.parse(f.createdTime ?? '');
        if (!live.has(f.name) && Number.isFinite(age) && age > ORPHAN_GRACE_MS) {
            await client.trashFile(f.id);
            trashedBlobs++;
        }
    }

    // trash commits เกิน retain
    let trashedCommits = 0;
    for (const c of commitFiles) {
        if (!seen.has(c.commitId)) { await client.trashFile(c.id); trashedCommits++; }
    }
    return { trashedBlobs, trashedCommits };
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `npm test -- src/backend/drive/__tests__/gc.test.ts`
Expected: PASS 5 เคส

- [ ] **Step 5: panel.html — เพิ่ม UI**

ใน `<select id="tavernsync_backend_mode">` เพิ่ม `<option value="drive">Google Drive</option>` และเพิ่มบล็อก (ต่อจาก field endpoint):

```html
<div id="tavernsync_drive_fields" style="display:none">
    <label>Google Client ID</label>
    <input id="tavernsync_client_id" type="text" class="text_pole" placeholder="xxxx.apps.googleusercontent.com" />
    <small>สร้างเองที่ Google Cloud Console — ดูคู่มือใน docs/google-drive-setup.md (ทุกเครื่องต้องใช้ Client ID เดียวกัน)</small>
    <div class="tavernsync_row">
        <div id="tavernsync_google_connect" class="menu_button">Connect Google</div>
        <div id="tavernsync_google_disconnect" class="menu_button">Disconnect</div>
    </div>
    <small>E2EE ถูกบังคับเปิดสำหรับ backend นี้ — ข้อมูลทุกไบต์เข้ารหัสก่อนถึง Google</small>
</div>
<div id="tavernsync_gc" class="menu_button">Clean up old data (Drive)</div>
```

- [ ] **Step 6: index.ts — bindings + handlers**

- `#tavernsync_backend_mode` change (index.ts:305 เดิม): ถ้า `drive` → แสดง `#tavernsync_drive_fields`, ซ่อน endpoint/token fields, บังคับ `e2eeEnabled = true` (disable checkbox พร้อม tooltip), saveSettings; ถ้า backend อื่น → ซ่อน, คืน checkbox
- `#tavernsync_client_id` change → `s.driveClientId = val; saveSettings()`
- `#tavernsync_google_connect` click → สร้าง `GisTokenProvider` ขอ token ครั้งแรก (gesture) → `requireRuntime()` → เก็บ `s.driveFolderId = layout.rootId` + ตั้ง `s.e2eeSalt = encodeSalt(await driveSaltFromFolderIdAsync(rootId))` → saveSettings → แสดง Storage line ผ่าน `adapter.quota()` (รูปแบบ `Google Drive: {used} / {limit} · TavernSync {itemCount} files`) → toastr 'Connected'
  - จับ `MultipleRootsError` → popup ให้เลือก root จากรายการ (`callGenericPopup` list) แล้วใช้ root ที่เลือก (ข้าม discovery ครั้งถัดไปด้วย folderId ที่จำไว้ — เพิ่ม optional param `knownFolderId` ให้ discoverDriveLayout)
- `#tavernsync_google_disconnect` click → `provider.revoke()` + toastr
- `#tavernsync_gc` click → confirm ก่อน → `collectGarbage(...)` → toastr สรุปจำนวนที่ trash (แสดงปุ่มเฉพาะ backendMode==='drive')
- `hydrateSettingsUI()` เพิ่ม hydrate ฟิลด์ใหม่ + visibility ตาม backendMode

- [ ] **Step 7: build + ตรวจใน ST จริง**

Run: `npm run build`
Expected: สำเร็จ ได้ `dist/index.<version>.js` ใหม่ — เปิด ST ดูแผง TavernSync เห็นตัวเลือก Google Drive (ยังไม่ต้องเชื่อมจริงใน task นี้ ถ้ายังไม่มี Client ID ให้เช็กแค่ UI render)

- [ ] **Step 8: Commit**

```bash
git add panel.html src/index.ts src/settings.ts src/backend/drive/gc.ts src/backend/drive/__tests__/gc.test.ts
git commit -m "feat(ui): Drive backend selector, Google connect, manual GC button"
```

---

### Task 10: Version bump + คู่มือผู้ใช้ + E2E checklist

**Files:**
- Modify: `package.json` (version → `0.2.0`), `src/settings.ts:6` (BUILD_ID → `'0.2.0'`), `manifest.json` (version/js/css → `0.2.0`)
- Create: `docs/google-drive-setup.md`

- [ ] **Step 1: bump version 3 จุด + build**

แก้ `package.json` version เป็น `0.2.0`, `src/settings.ts` BUILD_ID เป็น `'0.2.0'`, `manifest.json` ทั้ง `"version"`, `"js": "dist/index.0.2.0.js"`, `"css": "dist/style.0.2.0.css"`

Run: `npm run build && npm test`
Expected: build สำเร็จ (dist มี index.0.2.0.js) + เทสผ่านทั้งหมด

- [ ] **Step 2: เขียนคู่มือ docs/google-drive-setup.md**

เนื้อหาที่ต้องมี (ภาษาไทย):
1. สร้าง Google Cloud project → เปิดใช้ Google Drive API
2. ตั้ง OAuth consent screen (External, โหมด Testing — เตือน limit 100 test users + ต้องเพิ่มอีเมลตัวเองเป็น test user)
3. สร้าง OAuth Client ID แบบ Web application → ใส่ Authorized JavaScript origins ให้ตรง scheme/host/port ของ ST (เช่น `http://localhost:8000`; non-localhost ต้อง HTTPS; IP LAN ดิบใช้ไม่ได้)
4. วาง Client ID ในแผง → Connect Google → เครื่องแรกจะสร้างโฟลเดอร์ TavernSync อัตโนมัติ → เครื่องถัดไปใช้ Client ID + passphrase เดียวกัน
5. คำเตือน: อย่าลบโฟลเดอร์ TavernSync ใน Drive / เก็บ local backup เสมอ / ถ้า passphrase หายข้อมูลบน Drive อ่านไม่ได้

- [ ] **Step 3: Manual E2E checklist (ทำกับเครื่องจริง)**

ทำทีละข้อ ทิ้งผลไว้ใน PR/commit message:
- [ ] PC: Connect + Unlock + Push ข้อมูลจริงขึ้น Drive → เห็นโฟลเดอร์ TavernSync/manifests/blobs ในเว็บ Drive เป็นไฟล์ .enc + ชื่อ hex เท่านั้น
- [ ] เครื่อง 2 (หรือ browser profile อื่น): Client ID + passphrase เดียวกัน → Pull ได้ข้อมูลครบ
- [ ] แก้ไขคนละเครื่องสวนกัน → push ทั้งคู่ → fork ถูก merge / conflict UI เด้งตามคาด
- [ ] ปิดเน็ตกลาง push → push ใหม่ได้ปกติ ไม่มีไฟล์เสีย
- [ ] ใส่ passphrase ผิด → decrypt fail error ชัดเจน ไม่มีการเขียนทับ
- [ ] กด GC → ไฟล์กำลังใช้ไม่หาย, orphan เก่าถูก trash
- [ ] สลับกลับ backend Worker เดิม → push/pull ใช้ได้เหมือนเดิม (remembered key ไม่ปนกัน)

- [ ] **Step 4: Commit**

```bash
git add package.json manifest.json src/settings.ts docs/google-drive-setup.md
git commit -m "release: 0.2.0 — Google Drive backend"
```

---

## Self-Review ของ plan

- **Spec coverage:** §3 revision type → Task 1 · §4 RemoteSnapshot/fork → Task 1, 6, 7 · §5 OAuth/bootstrap → Task 8, 9 · §6 crypto/runtime/salt → Task 2, 3, 8 · §7 commits/retention/N-head → Task 6 (retention prune ฝั่งเขียนอยู่ใน GC Task 9) · §8 blobs/quota/GC → Task 5, 9 · §9 error handling → กระจายทุก task (DriveAuthError ใน Task 4, ConflictError ใน Task 6, ฯลฯ) · §10 testing → ทุก task มีเทส + Task 10 E2E
- **Placeholder scan:** เทส 3 ก้อนใน Task 6 Step 5 และ GC tests Task 9 Step 1 มีเฉพาะโครง — implementer ต้องเติม body ตาม pattern ที่ให้ (ระบุไว้ชัดเจนในแต่ละจุด)
- **Type consistency:** `RemoteSnapshot/StorageRevision` (Task 1) → ใช้ตรงกัน Task 5/6/7; `BackendCrypto/BackendRuntime/SaltProvider` (Task 2) → ใช้ตรงกัน Task 5/8/9; `DriveClient` methods (Task 4 + searchRootFolders เพิ่มใน Task 5) → ใช้ตรงกัน Task 5/6/9; `CommitMeta/parseCommitMeta/computeHeads/revisionOfHeads/findCommonAncestor/MAX_PARENTS/COMMIT_ID_LEN` (Task 6) ใช้ตรงกัน Task 9
