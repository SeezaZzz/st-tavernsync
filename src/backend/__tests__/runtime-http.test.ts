import { describe, expect, it } from 'vitest';
import { makeHttpCrypto } from '../runtime';
import { deriveKey, open } from '../../crypto';

async function sha256Hex(data: Uint8Array): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
        await expect(c.decryptBlob(boxed, await sha256Hex(data))).resolves.toEqual(data);
    });

    it('decryptBlob รับ plaintext blob เก่ายุค E2EE ปิด (raw hash fallback)', async () => {
        const { key } = await deriveKey('pass', new Uint8Array(16).fill(2));
        const c = makeHttpCrypto(key);
        const plain = new TextEncoder().encode('legacy plaintext blob');
        await expect(c.decryptBlob(plain, await sha256Hex(plain))).resolves.toEqual(plain);
        await expect(c.decryptBlob(plain, 'deadbeef')).rejects.toThrow();
    });

    it('encodeManifest เป็น JSON ธรรมดา (worker เก็บ plaintext manifest)', async () => {
        const c = makeHttpCrypto(null);
        const m = { version: 1, schema: 1 as const, device: 'pc', updatedAt: 1, items: {} };
        const enc = await c.encodeManifest(m);
        expect(JSON.parse(new TextDecoder().decode(enc))).toEqual(m);
    });
});
