import { describe, expect, it } from 'vitest';
import { makeDriveCrypto } from '../runtime';
import { deriveDriveSubkeys, type DriveSubkeys } from '../../crypto/subkeys';
import type { Manifest } from '../../sync-core/types';

async function sha256Hex(data: Uint8Array): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeSubkeys(): Promise<DriveSubkeys> {
    return deriveDriveSubkeys(new Uint8Array(32).fill(7), 'folder_abc');
}

describe('makeDriveCrypto', () => {
    it('encryptBlob/decryptBlob รอบทริป (seal/open ด้วย blobEnc subkey)', async () => {
        const c = makeDriveCrypto(await makeSubkeys());
        const data = new TextEncoder().encode('hello drive');
        const boxed = await c.encryptBlob(data);
        expect(boxed).not.toEqual(data); // เข้ารหัสจริง
        await expect(c.decryptBlob(boxed, await sha256Hex(data))).resolves.toEqual(data);
    });

    it('decryptBlob โยนเมื่อ plaintext hash ไม่ตรง', async () => {
        const c = makeDriveCrypto(await makeSubkeys());
        const data = new TextEncoder().encode('hello drive');
        const boxed = await c.encryptBlob(data);
        await expect(c.decryptBlob(boxed, 'deadbeef')).rejects.toThrow('blob hash mismatch');
        // ciphertext เสีย → open ล้มเหลว (GCM auth tag)
        const corrupt = boxed.slice();
        corrupt[corrupt.length - 1] ^= 0xff;
        await expect(c.decryptBlob(corrupt, await sha256Hex(data))).rejects.toThrow();
    });

    it('encodeManifest ไม่ deterministic (IV สุ่ม) แต่ decode กลับได้ plaintext เดิม', async () => {
        const c = makeDriveCrypto(await makeSubkeys());
        const m: Manifest = { version: 3, schema: 1, device: 'pc', updatedAt: 42, items: {} };
        const enc1 = await c.encodeManifest(m);
        const enc2 = await c.encodeManifest(m);
        expect(enc1).not.toEqual(enc2); // ciphertext ต่างกัน → commitId ไม่ชน
        await expect(c.decodeManifest(enc1)).resolves.toEqual(m);
        await expect(c.decodeManifest(enc2)).resolves.toEqual(m);
    });

    it('blobNameFor เป็น HMAC hex 64 ตัวอักษร และ deterministic ต่อ hash เดิม', async () => {
        const c = makeDriveCrypto(await makeSubkeys());
        const name1 = await c.blobNameFor('abc123');
        expect(name1).toMatch(/^[0-9a-f]{64}$/);
        expect(await c.blobNameFor('abc123')).toBe(name1);
        expect(await c.blobNameFor('abc124')).not.toBe(name1);
        // key ต่าง (folderId ต่าง) → ชื่อต่าง
        const other = makeDriveCrypto(await deriveDriveSubkeys(new Uint8Array(32).fill(7), 'folder_xyz'));
        expect(await other.blobNameFor('abc123')).not.toBe(name1);
    });
});
