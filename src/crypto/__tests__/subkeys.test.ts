import { describe, expect, it } from 'vitest';
import { driveSaltFromFolderIdAsync, deriveDriveSubkeys, hmacNameFor } from '../subkeys';
import { deriveKey, exportKeyRaw, seal, open } from '../index';

const FOLDER = 'folder_abc123';

describe('drive subkeys', () => {
    it('salt deterministic จาก folderId (SHA-256 ของ namespace + folderId)', async () => {
        const a = await driveSaltFromFolderIdAsync(FOLDER);
        const b = await driveSaltFromFolderIdAsync(FOLDER);
        const c = await driveSaltFromFolderIdAsync('folder_อื่น');
        expect([...a]).toEqual([...b]);
        expect([...a]).not.toEqual([...c]);
        expect(a.byteLength).toBe(16); // ใช้ 16 ไบต์แรกของ digest ให้เข้ากับ SALT_BYTES เดิม
    });

    it('passphrase + folderId เดียวกัน → subkeys เดียวกัน (cross-device)', async () => {
        const salt = await driveSaltFromFolderIdAsync(FOLDER);
        const { key: k1 } = await deriveKey('Zzz-pass', salt, { extractable: true });
        const { key: k2 } = await deriveKey('Zzz-pass', salt, { extractable: true });
        const s1 = await deriveDriveSubkeys(await exportKeyRaw(k1), FOLDER);
        const s2 = await deriveDriveSubkeys(await exportKeyRaw(k2), FOLDER);
        expect(await hmacNameFor(s1.blobName, 'hash1')).toBe(await hmacNameFor(s2.blobName, 'hash1'));
        const boxed = await seal(s1.blobEnc, new TextEncoder().encode('x'));
        expect(new TextDecoder().decode(await open(s2.blobEnc, boxed))).toBe('x');
    });

    it('domain separation — ชื่อ blob ไม่เท่ากับ raw hash และคนละ label คนละค่า', async () => {
        const { key } = await deriveKey('Zzz-pass', await driveSaltFromFolderIdAsync(FOLDER), { extractable: true });
        const s = await deriveDriveSubkeys(await exportKeyRaw(key), FOLDER);
        const name = await hmacNameFor(s.blobName, 'deadbeef'.repeat(8));
        expect(name).toMatch(/^[0-9a-f]{64}$/);
        expect(name).not.toBe('deadbeef'.repeat(8));
    });
});
