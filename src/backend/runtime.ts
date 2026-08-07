import type { Manifest } from '../sync-core/types';
import type { StorageAdapter } from './adapter';
import { HttpStorageAdapter } from './http';
import { DriveClient } from './drive/client';
import { DriveAdapter, discoverDriveLayout } from './drive/adapter';
import { GisTokenProvider } from './drive/oauth';
import { getSettings } from '../settings';
import { seal, open, decodeSalt, encodeSalt, exportKeyRaw } from '../crypto';
import { deriveDriveSubkeys, driveSaltFromFolderIdAsync, hmacNameFor, type DriveSubkeys } from '../crypto/subkeys';
// sessionKey ถูก engine จัดการ — import getter ที่ engine เปิดไว้ (ดู Step 4)
import { getSessionKey } from '../sync/engine';

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

/** Drive crypto: E2EE บังคับ — manifest เข้ารหัสทั้งก้อน (seal = IV สุ่มทุกครั้ง), ชื่อ blob = HMAC */
export function makeDriveCrypto(subkeys: DriveSubkeys): BackendCrypto {
    return {
        encryptBlob: d => seal(subkeys.blobEnc, d),
        async decryptBlob(data, expectedPlaintextHash) {
            const pt = await open(subkeys.blobEnc, data);
            if ((await sha256Hex(pt)) !== expectedPlaintextHash) throw new Error('blob hash mismatch');
            return pt;
        },
        encodeManifest: m => seal(subkeys.manifestEnc, new TextEncoder().encode(JSON.stringify(m))),
        decodeManifest: async d => JSON.parse(new TextDecoder().decode(await open(subkeys.manifestEnc, d))) as Manifest,
        blobNameFor: h => hmacNameFor(subkeys.blobName, h),
    };
}

class DriveSaltProvider implements SaltProvider {
    constructor(private folderId: string) {}
    async getSalt() { return driveSaltFromFolderIdAsync(this.folderId); }
    async ensureSalt(_local: Uint8Array) { return driveSaltFromFolderIdAsync(this.folderId); } // deterministic — ไม่สน local
}

export async function requireRuntime(): Promise<BackendRuntime> {
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
        const crypto = makeDriveCrypto(subkeys);
        return {
            storage: new DriveAdapter(client, crypto, layout),
            crypto,
            saltProvider: new DriveSaltProvider(layout.rootId),
            storageNamespace: `drive:${layout.rootId}`,
        };
    }
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
